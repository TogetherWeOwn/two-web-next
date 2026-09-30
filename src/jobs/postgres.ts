import type postgres from "postgres";
import type { SingleFlight, } from "./cron";
import type { QueueLedger, UniqueLock } from "./types";

type Sql = ReturnType<typeof postgres>;

/** Transaction-scoped advisory lock: released on commit/rollback/disconnect, so a crashed run never wedges the job. */
export function pgSingleFlight(sql: Sql): SingleFlight {
  return async (name, fn) => {
    let ran = false;
    await sql.begin(async (tx) => {
      const [row] = await tx`select pg_try_advisory_xact_lock(hashtextextended(${name}, 0)) as got`;
      if (!row?.got) return; // another invocation holds it: skip, cheap when idle
      ran = true;
      await fn();
    });
    return ran;
  };
}

/** ShouldBeUnique lock with TTL (Cache::lock equivalent). Atomic: one upsert that only wins over expired rows. */
export function pgUniqueLock(sql: Sql): UniqueLock {
  return {
    async acquire(key, ttlSeconds) {
      const rows = await sql`
        insert into job_unique_locks (key, expires_at) values (${key}, now() + make_interval(secs => ${ttlSeconds}))
        on conflict (key) do update set expires_at = excluded.expires_at
          where job_unique_locks.expires_at < now()
        returning key`;
      return rows.length > 0;
    },
    async release(key) {
      await sql`delete from job_unique_locks where key = ${key}`;
    },
  };
}

/**
 * A same-key row that can no longer belong to a live transport message: never
 * picked up (`reserved_at` null) and available for longer than any legitimate
 * delivery lag. The only writer that can observe a key's staleness is the next
 * dispatch of that key, so `enqueued` sweeps these before inserting. Live rows
 * are never matched: a delayed/retrying message has a future `available_at`,
 * a message being handled has `reserved_at` set, and every redelivery refreshes
 * one of the two. The bound is deliberately generous (hours vs. the seconds a
 * real delivery takes) — an orphan lingers visibly a while rather than risk a
 * live row.
 */
export const LEDGER_ORPHAN_GRACE_SECONDS = 3600;

/**
 * N3 (TOG-9895): the Postgres side of the queue ledger. Cloudflare Queues is the
 * transport and exposes no depth API, so this ledger is the `jobs` table of the
 * port — the rows `pgQueueDepth` counts for GET /up. Dispatch writes through
 * `trackingQueue`; the consumer calls the rest.
 */
export function pgQueueLedger(sql: Sql): QueueLedger {
  return {
    async enqueued({ jobId, kind, key, availableAt }) {
      // One row per accepted transport message. `job_id` is the primary key
      // (minted per dispatch), so each live message keeps its own transitions
      // even when a retry delay (up to 3600s) outlives the 300s uniqueness
      // window and a second dispatch of the same event key lands while the
      // first message is still delayed or reserved. (An earlier key-upsert
      // collapsed that case to one row and lost the first message.)
      if (key !== null) {
        // Proven-orphan sweep for this key (see LEDGER_ORPHAN_GRACE_SECONDS).
        // Hygiene only: its failure must never block the dispatch itself.
        const staleBefore = new Date(Date.now() - LEDGER_ORPHAN_GRACE_SECONDS * 1000);
        await sql`
          delete from queue_jobs
          where key = ${key} and reserved_at is null and available_at < ${staleBefore}`.catch((e: unknown) =>
          console.warn("queue ledger orphan sweep failed", e instanceof Error ? e.message : e),
        );
      }
      await sql`
        insert into queue_jobs (job_id, kind, key, available_at)
        values (${jobId}::uuid, ${kind}, ${key}, ${availableAt})`;
    },
    async reserved(jobId) {
      await sql`update queue_jobs set reserved_at = now() where job_id = ${jobId}::uuid`;
    },
    async released(jobId, availableAt) {
      await sql`
        update queue_jobs set reserved_at = null, available_at = ${availableAt}
        where job_id = ${jobId}::uuid`;
    },
    async dequeued(jobId) {
      await sql`delete from queue_jobs where job_id = ${jobId}::uuid`;
    },
    async failed(jobId, kind, key, reason) {
      await sql.begin(async (tx) => {
        await tx`
          insert into queue_failed_jobs (job_id, kind, key, reason)
          values (${jobId}::uuid, ${kind}, ${key}, ${reason.slice(0, 2000)})`;
        await tx`delete from queue_jobs where job_id = ${jobId}::uuid`;
      });
    },
  };
}

/** The one counted shape: pending/delayed/reserved/total/failed + oldest pending age. */
export type QueueDepth = {
  pending: number;
  delayed: number;
  reserved: number;
  total: number;
  failed: number;
  oldestPendingAgeSeconds: number | null;
};

/**
 * Ports QueueHealth::measure() onto the ledger: one round-trip, the same bucket
 * semantics (pending = available now and unclaimed; delayed = not yet available,
 * counted even when claimed, same as legacy). Throws on driver/table error — the
 * caller maps that to `queue.status: unknown`, never a 500.
 */
export async function pgQueueDepth(sql: Sql): Promise<QueueDepth> {
  const [row] = await sql`
    select
      count(*) filter (where available_at <= now() and reserved_at is null)::int as pending,
      count(*) filter (where available_at > now())::int as delayed,
      count(*) filter (where reserved_at is not null)::int as reserved,
      count(*)::int as total,
      (select count(*)::int from queue_failed_jobs) as failed,
      extract(epoch from now() - (min(created_at) filter (where available_at <= now() and reserved_at is null)))::int
        as oldest_pending_age_seconds
    from queue_jobs`;
  if (!row) throw new Error("queue depth query returned no row");
  return {
    pending: row.pending,
    delayed: row.delayed,
    reserved: row.reserved,
    total: row.total,
    failed: row.failed,
    oldestPendingAgeSeconds: row.oldest_pending_age_seconds,
  };
}
