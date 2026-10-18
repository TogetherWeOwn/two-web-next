import type { Sql } from "postgres";
import { ulid } from "./payload";
import type { Answer, Grant, IngressConfig, Op } from "./types";

/** One 429 shape for every throttle on this ingress (two-web TOG-6788). */
export function throttleEnvelope(retryAfterSeconds: number): Answer {
  const retry = Math.max(1, retryAfterSeconds);
  return {
    status: 429,
    body: {
      reason: "rate_limited",
      message: `Too many requests. Try again in ${retry} seconds.`,
      retry_after: retry,
    },
    headers: { "Retry-After": String(retry) },
  };
}

/** One 503 shape for inner-budget lock contention (retryable, never a denial). */
export function busyEnvelope(requestId: string): Answer {
  return {
    status: 503,
    body: {
      reason: "operation_busy",
      message: "The rate limiter is busy admitting requests. Retry with the same idempotency key.",
      request_id: requestId,
    },
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
      await tx.unsafe(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(cfg.lockWaitMs))}ms'`);
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
      if (retry > 0) return throttleEnvelope(retry);
      for (const [bucket] of buckets)
        await tx`INSERT INTO agent_event_hits (bucket) VALUES (${bucket})`;
      return null;
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "55P03") throw err;
    // Inner-budget lock contention: the verdict transaction aborted with no
    // hits inserted. Prune best-effort outside the bucket locks so a busy
    // pass still drains expired rows, then answer retryable 503. The caller
    // audits it once as error/operation_busy.
    try {
      await sql`WITH candidates AS (SELECT id FROM agent_event_hits WHERE at < now() - interval '5 minutes' ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED) DELETE FROM agent_event_hits USING candidates WHERE agent_event_hits.id = candidates.id`;
    } catch {
      // The busy verdict stands even when housekeeping fails.
    }
    return busyEnvelope(requestId ?? ulid());
  }
  // Expiry cleanup runs after the verdict — admitted or refused — outside the
  // bucket advisory locks, so a prune never prolongs the admission lock and a
  // bucket under sustained refused load still drains. Capped per pass at the
  // outer shield's standard; the candidate select is SKIP LOCKED so expired
  // rows held by unrelated transactions are left for a later pass instead of
  // stalling admission. Best-effort: housekeeping must never flip a decided
  // verdict into an admission or a 500.
  try {
    await sql`WITH candidates AS (SELECT id FROM agent_event_hits WHERE at < now() - interval '5 minutes' ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED) DELETE FROM agent_event_hits USING candidates WHERE agent_event_hits.id = candidates.id`;
  } catch {
    // The verdict above was already decided.
  }
  return verdict;
}
