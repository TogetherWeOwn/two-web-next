import type { Sql } from "postgres";
import { createLogBudget } from "../log-budget";
import type { Answer, IngressConfig } from "./types";
import { audit, auditOperationBusy } from "./audit";
import { ingressDenial } from "./envelope";
import { pruneAgentEventHits } from "./prune-hits";
import { throttleEnvelope } from "./rate-limit";
import { isIngressBusy, setIngressDeadlines } from "./deadline";

// The outer shield's counter (two-web TOG-8402): one bucket per credential
// hash (or anonymous IP), counted before auth. Returns the 429 envelope when
// the budget is spent — sampled-audited as denied/rate_limited with the
// admission's own request_id, pre-auth like contention (grant_id null) —
// and records the hit otherwise.
//
// The audit row records the bucket CLASS in the existing columns, never raw
// identity: credentialed refusals carry the credential's sha256 hash in
// payload_digest with operation `shield:credential`; anonymous refusals carry
// operation `shield:anonymous` and a null digest, identical across addresses.
// No IP bytes, raw credential, or `shield:ip:` bucket ever reaches the row.
//
// Over-budget refusals are attacker-proportional by definition, so the audit
// write is sampled (~1%, SHIELD_REFUSAL_AUDIT_RATE, matching the pre-auth warn
// precedent): flood tests assert exact row counts under a forced sampler, not
// live randomness. Every over-budget verdict still increments the in-memory
// counters below; only final 429s take a token from the in-memory log bucket: on
// success it warns `agent-events.shield.refused` (bucket class + outcome
// only), otherwise it folds into the bounded `agent-events.shield.refused.shed`
// signal carrying the drop count since the previous shed emit. The bucket
// bounds log volume while the shed signal keeps a storm visible — a shedding
// shield reads as a storm, never as silence. Lock-contention 503s keep their
// exact error audit (retryable load signal, not attacker-proportional volume).
//
// Two properties the exact-head review pinned down:
// - The advisory lock waits at most lockWaitMs (SET LOCAL lock_timeout, as in
//   the operation transaction). Contention is a 503 operation_busy audited as
//   an error — a retryable answer, never a hung connection.
// - Stale counters are pruned after the admission transaction, never while a
//   bucket lock is held. Cleanup is single-flighted and uses a 1ms lock timeout;
//   a held row or concurrent prune defers cleanup without delaying the verdict.
//   Denied-only and replay-only periods still run the cleanup, so expiry no
//   longer depends on a successful authenticated operation reaching the inner
//   rate limiter.
/** Bucket class for the outer-shield audit row: credential hash, never raw identity. */
export type ShieldBucketClass = { kind: "credential"; hash: string } | { kind: "anonymous" };

/** Sampled audit rate for over-budget shield refusals (see header). */
export const SHIELD_REFUSAL_AUDIT_RATE = 0.01;

/**
 * In-memory volume signal for over-budget shield refusals, by bucket class.
 * Incremented on every over-budget verdict whether or not the audit row is sampled.
 * The log line no longer carries the running count: every final 429 warns
 * `agent-events.shield.refused` with the bucket class and outcome only
 * (token-bucketed, with a bounded shed signal), so flood volume stays
 * observable in logs without attacker-proportional table or log growth.
 * Process-local like every Worker isolate's counters; responders multiply
 * sampled audit rows by ~100 (see docs/agent-events.md). Pinned by the
 * counter test in test/agent-events-shield-429-bounded-audit.test.ts.
 */
export const shieldRefusalCounters = { credential: 0, anonymous: 0 };

const takeShieldLogToken = createLogBudget("agent-events.shield.refused.shed");

/** Test seam: reset {@link shieldRefusalCounters} between cases. */
export function __resetShieldRefusalCountersForTests(): void {
  shieldRefusalCounters.credential = 0;
  shieldRefusalCounters.anonymous = 0;
}

export async function shield(
  sql: Sql,
  cfg: IngressConfig,
  shieldKey: string,
  requestId: string,
  bucketClass: ShieldBucketClass,
): Promise<Answer | null> {
  const bucket = `shield:${shieldKey}`;
  let retryAfter: number | null = null;
  try {
    const wait = await sql.begin(async (tx) => {
      await setIngressDeadlines(tx, cfg.lockWaitMs);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-event-hits:${bucket}`}, 0))`;
      const [r] =
        await tx`SELECT count(*)::int AS n, coalesce(ceil(extract(epoch FROM (min(at) + interval '60 seconds' - now()))), 1)::int AS wait
                           FROM agent_event_hits WHERE bucket = ${bucket} AND at > now() - interval '60 seconds'`;
      if (r!.n >= cfg.routePerMinute) return Math.max(1, r!.wait) as number;
      await tx`INSERT INTO agent_event_hits (bucket) VALUES (${bucket})`;
      return null as number | null;
    });
    await pruneAgentEventHits(sql);
    if (wait === null) return null;
    retryAfter = wait;
  } catch (err) {
    if (isIngressBusy(err)) {
      // Contention, not a decision. Audited as an error so a run of these reads as load.
      // The audit runs in its own short deadline-bound transaction after the
      // admission settled; an expected audit timeout keeps this same 503.
      await auditOperationBusy(sql, cfg.lockWaitMs, null, "unknown", null, null, null, requestId);
      return {
        status: 503,
        body: ingressDenial(
          "operation_busy",
          "The ingress is busy admitting requests. Retry with the same idempotency key.",
          requestId,
        ),
      };
    }
    throw err;
  }
  // Over-budget, not contention: at most a sampled audit row outside the
  // bucket lock so storm refusal volume never prolongs admission. Same
  // pre-auth shape as contention (grant_id null) with the inner refusal's
  // denied/rate_limited outcome; the refused hit still writes no hit row.
  // The counter below records every refusal; the row is the sample.
  // The sampled write runs in its own transaction with lock and statement
  // timeouts derived from the admission's lock wait, so a stalled audit
  // answers retryable 503 instead of stalling the refusal. No advisory
  // lock, hit write, or grant lookup.
  shieldRefusalCounters[bucketClass.kind] += 1;
  if (Math.random() < SHIELD_REFUSAL_AUDIT_RATE) {
    const operation = bucketClass.kind === "credential" ? "shield:credential" : "shield:anonymous";
    const dig = bucketClass.kind === "credential" ? bucketClass.hash : null;
    const auditTimeoutMs = Math.max(1, Math.floor(cfg.lockWaitMs));
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '${auditTimeoutMs}ms'`);
        await tx.unsafe(`SET LOCAL statement_timeout = '${auditTimeoutMs}ms'`);
        await audit(tx, null, operation, null, null, dig, requestId, "denied", "rate_limited");
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "55P03" || code === "57014") {
        return {
          status: 503,
          body: ingressDenial(
            "operation_busy",
            "The ingress is busy admitting requests. Retry with the same idempotency key.",
            requestId,
          ),
        };
      }
      throw err;
    }
  }
  // Only final 429s spend log tokens: a sampled audit failure above can instead
  // return 503 or throw. Class + outcome only, never identity or body bytes.
  if (takeShieldLogToken())
    console.warn("agent-events.shield.refused", {
      bucket_class: bucketClass.kind,
      outcome: "rate_limited",
    });
  return throttleEnvelope(retryAfter ?? 1, requestId);
}
