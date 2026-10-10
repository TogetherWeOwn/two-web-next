import type { Sql } from "postgres";
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

export async function rateLimit(
  sql: Sql,
  cfg: IngressConfig,
  grant: Grant,
  op: Op,
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
  return sql.begin(async (tx) => {
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
    await tx`DELETE FROM agent_event_hits WHERE at < now() - interval '5 minutes'`;
    return null;
  });
}
