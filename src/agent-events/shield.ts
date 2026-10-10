import type { Sql } from "postgres";
import type { Answer, IngressConfig } from "./types";
import { audit } from "./audit";
import { throttleEnvelope } from "./rate-limit";

// The outer shield's counter (two-web TOG-8402): one bucket per credential
// hash (or anonymous IP), counted before auth. Returns the 429 envelope when
// the budget is spent — audited by nobody, since the hit never reached auth —
// and records the hit otherwise.
//
// Two properties the exact-head review pinned down:
// - The advisory lock waits at most lockWaitMs (SET LOCAL lock_timeout, as in
//   the operation transaction). Contention is a 503 operation_busy audited as
//   an error — a retryable answer, never a hung connection.
// - Stale counters are pruned here, on every shield pass, capped per pass so a
//   long-idle table cannot stall admission. The candidate select is SKIP LOCKED
//   so expired rows held by unrelated transactions are left for a later pass
//   instead of turning a fresh credential's admission into a 503. Denied-only
//   and replay-only periods still run this transaction, so expiry no longer
//   depends on a successful authenticated operation reaching the inner rate
//   limiter.
export async function shield(
  sql: Sql,
  cfg: IngressConfig,
  shieldKey: string,
  requestId: string,
): Promise<Answer | null> {
  const bucket = `shield:${shieldKey}`;
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(cfg.lockWaitMs))}ms'`);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-event-hits:${bucket}`}, 0))`;
      await tx`WITH candidates AS (SELECT id FROM agent_event_hits WHERE at < now() - interval '5 minutes' ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED) DELETE FROM agent_event_hits USING candidates WHERE agent_event_hits.id = candidates.id`;
      const [r] =
        await tx`SELECT count(*)::int AS n, coalesce(ceil(extract(epoch FROM (min(at) + interval '60 seconds' - now()))), 1)::int AS wait
                           FROM agent_event_hits WHERE bucket = ${bucket} AND at > now() - interval '60 seconds'`;
      if (r!.n >= cfg.routePerMinute) return throttleEnvelope(Math.max(1, r!.wait));
      await tx`INSERT INTO agent_event_hits (bucket) VALUES (${bucket})`;
      return null;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "55P03") {
      // Contention, not a decision. Audited as an error so a run of these reads as load.
      await audit(sql, null, "unknown", null, null, null, requestId, "error", "operation_busy");
      return {
        status: 503,
        body: {
          reason: "operation_busy",
          message: "The ingress is busy admitting requests. Retry with the same idempotency key.",
          request_id: requestId,
        },
      };
    }
    throw err;
  }
}
