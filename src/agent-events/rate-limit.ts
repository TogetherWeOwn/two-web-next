import type { Sql } from "postgres";
import { ingressDenial } from "./envelope";
import { isIngressBusy, setIngressDeadlines } from "./deadline";
import { ulid } from "./payload";
import { pruneAgentEventHits } from "./prune-hits";
import type { Answer, Grant, IngressConfig, Op } from "./types";

/** One 429 shape for every throttle on this ingress (two-web TOG-6788). */
export function throttleEnvelope(retryAfterSeconds: number, requestId: string): Answer {
  const retry = Math.max(1, retryAfterSeconds);
  return {
    status: 429,
    body: ingressDenial(
      "rate_limited",
      `Too many requests. Try again in ${retry} seconds.`,
      requestId,
      { retry_after: retry },
    ),
    headers: { "Retry-After": String(retry) },
  };
}

/** One 503 shape for inner-budget lock contention (retryable, never a denial). */
export function busyEnvelope(requestId: string): Answer {
  return {
    status: 503,
    body: ingressDenial(
      "operation_busy",
      "The rate limiter is busy admitting requests. Retry with the same idempotency key.",
      requestId,
    ),
  };
}

export async function rateLimit(
  sql: Sql,
  cfg: IngressConfig,
  grant: Grant,
  op: Op,
  requestId?: string,
): Promise<Answer | null> {
  const read = op === "read";
  const buckets: [string, number][] = [
    [
      `${read ? "read" : "mutating"}:${grant.id}`,
      read ? cfg.readsPerMinute : cfg.mutatingPerMinute,
    ],
    [
      read ? "service-read" : "service-mutating",
      read ? cfg.serviceReadsPerMinute : cfg.serviceMutatingPerMinute,
    ],
  ];
  let verdict: Answer | null;
  try {
    verdict = await sql.begin(async (tx) => {
      await setIngressDeadlines(tx, cfg.lockWaitMs);
      let retry = 0;
      for (const [bucket] of [...buckets].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-event-hits:${bucket}`}, 0))`;
      }
      for (const [bucket, max] of buckets) {
        const [r] =
          await tx`SELECT count(*)::int AS n, coalesce(ceil(extract(epoch FROM (min(at) + interval '60 seconds' - now()))), 1)::int AS wait
                             FROM agent_event_hits WHERE bucket = ${bucket} AND at > now() - interval '60 seconds'`;
        if (r!.n >= max) retry = Math.max(retry, Math.max(1, r!.wait));
      }
      if (retry > 0) return throttleEnvelope(retry, requestId ?? ulid());
      for (const [bucket] of buckets)
        await tx`INSERT INTO agent_event_hits (bucket) VALUES (${bucket})`;
      return null;
    });
  } catch (err) {
    if (!isIngressBusy(err)) throw err;
    // Inner-budget lock contention: the verdict transaction aborted with no
    // hits inserted. Best-effort cleanup runs outside the bucket locks so a
    // busy pass still attempts to drain expired rows, then answer retryable
    // 503. The caller audits it once as error/operation_busy.
    await pruneAgentEventHits(sql);
    return busyEnvelope(requestId ?? ulid());
  }
  // Expiry cleanup runs after the verdict — admitted or refused — outside the
  // bucket advisory locks, so a prune never prolongs the admission transaction
  // and a bucket under sustained refused load still drains. It is single-flighted
  // and lock-time-bounded; a held row or concurrent cleanup defers to a later
  // pass. Housekeeping must never flip a decided verdict into an admission or a
  // 500.
  await pruneAgentEventHits(sql);
  return verdict;
}
