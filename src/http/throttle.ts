import { PER_REQUEST_STATEMENT_TIMEOUT_LOCAL } from "../db/connection";
import type { Sql } from "../sessions";

/**
 * Bound on the per-bucket admission-lock wait. A held `web-throttle:` advisory
 * lock raises 55P03 with no hit charged rather than hanging a request behind
 * another isolate's admission. Sized above the ~1s held-lock windows pinned by
 * the concurrency suite and well inside the 4s busy bound in
 * `test/web-throttle-lock-busy.test.ts`.
 */
export const WEB_THROTTLE_LOCK_TIMEOUT_MS = 2000;

export type ThrottleVerdict = { limited: false } | { limited: true; retryAfter: number };
type ThrottlePruneFailure = "deadline" | { err: unknown };

// The privacy policy promises this window for rate-limit counters; change it only with a policy version.
export const THROTTLE_COUNTER_RETENTION_MINUTES = 5;

/**
 * Named wait for the best-effort throttle prune: the already-decided verdict
 * returns after at most this long, whether or not the database cancels the
 * statement.
 */
const THROTTLE_PRUNE_WAIT_MS = 2_000;

/** Charge the shared Postgres window; the caller owns outage policy and cleanup. */
export async function chargeWebThrottle(
  sql: Sql,
  bucket: string,
  max: number,
): Promise<ThrottleVerdict> {
  // The native postgres.js store supports transactions; the session SQL seam
  // deliberately exposes only the statements needed by session stores.
  const store = sql as Sql & {
    begin: (run: (tx: Sql) => Promise<ThrottleVerdict>) => Promise<ThrottleVerdict>;
  };
  return store.begin(async (tx) => {
    // Bound the admission-lock wait: without this, a bucket whose advisory
    // lock is held by another isolate blocks here until the holder commits.
    // Same `SET LOCAL lock_timeout` shape as the agent-events shield, inner
    // limiter and ingress operation locks.
    await tx.unsafe(`SET LOCAL lock_timeout = '${WEB_THROTTLE_LOCK_TIMEOUT_MS}ms'`);
    // Per-request statement bound: a lock timeout alone cannot cancel an
    // executing statement, so the INSERT below also carries the shared
    // 5 s bound. It sits above the 2 s lock timeout, so lock waits still
    // raise 55P03 while executing statements cancel with 57014 and
    // propagate to the callers' fail-open/outage handling.
    await tx.unsafe(PER_REQUEST_STATEMENT_TIMEOUT_LOCAL);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`web-throttle:${bucket}`}, 0))`;
    // now() is transaction-start time, which can precede a long lock wait.
    const rows = await tx<{ n: number; wait: number }[]>`
      SELECT count(*)::int AS n,
        coalesce(ceil(extract(epoch FROM (min(at) + interval '60 seconds' - clock_timestamp()))), 1)::int AS wait
      FROM web_throttle_hits WHERE bucket = ${bucket} AND at > clock_timestamp() - interval '60 seconds'`;
    const r = rows[0];
    if (r && r.n >= max) return { limited: true, retryAfter: Math.max(1, r.wait) };
    await tx`INSERT INTO web_throttle_hits (bucket, at) VALUES (${bucket}, clock_timestamp())`;
    return { limited: false };
  });
}

/** Run one age-only batch outside the admission transaction. */
export async function pruneWebThrottle(sql: Sql): Promise<ThrottlePruneFailure | null> {
  const pruneDelete = (tx: Sql) =>
    tx`DELETE FROM web_throttle_hits USING (SELECT id FROM web_throttle_hits WHERE at < now() - make_interval(mins => ${THROTTLE_COUNTER_RETENTION_MINUTES}) ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED) AS candidates WHERE web_throttle_hits.id = candidates.id`;
  const pruneStore = sql as Sql & {
    begin: (run: (tx: Sql) => Promise<void>) => Promise<void>;
  };
  const prune = (async () => {
    try {
      await pruneStore.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = '${THROTTLE_PRUNE_WAIT_MS}ms'`);
        await pruneDelete(tx);
      });
      return null;
    } catch (err) {
      return { err };
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), THROTTLE_PRUNE_WAIT_MS);
  });
  try {
    return await Promise.race([prune, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Allow a missing store, refuse a busy bucket, and leave all other admission
 * errors to the caller's outage policy. Report cleanup failures separately.
 */
export async function checkWebThrottle(
  sql: Sql | null,
  bucket: string,
  max: number,
  onPruneFailure?: (failure: ThrottlePruneFailure) => void,
): Promise<ThrottleVerdict> {
  if (!sql) return { limited: false };

  let verdict: ThrottleVerdict;
  try {
    verdict = await chargeWebThrottle(sql, bucket, max);
  } catch (err) {
    if ((err as { code?: string }).code !== "55P03") throw err;
    // The admission transaction aborted without inserting a hit.
    verdict = { limited: true, retryAfter: 1 };
  }
  // Prune outside the admission lock, including on refusal. A failure or a
  // delay never changes the verdict; late settlements are observed by the helper.
  const failure = await pruneWebThrottle(sql);
  if (failure !== null) onPruneFailure?.(failure);
  return verdict;
}
