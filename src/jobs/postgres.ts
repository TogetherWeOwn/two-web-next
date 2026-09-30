import type postgres from "postgres";
import { createPostgresSessionStore, type Sql as SessionSql } from "../sessions";
import type { SingleFlight, } from "./cron";
import type { AgePrunedTable, PruneStores, QueueLedger, TxClient, UniqueLock } from "./types";

type Sql = ReturnType<typeof postgres>;

/**
 * Transaction-scoped advisory lock: released on commit/rollback/disconnect,
 * so a crashed run never wedges the job. The body runs INSIDE the reserved
 * transaction on that same connection (`fn(tx)`): the pool is `max: 1`, so a
 * body query on the outer pool would wait for the connection this transaction
 * holds and hang until the worker limit kills it.
 */
export function pgSingleFlight(sql: Sql): SingleFlight {
  return async (name, fn) => {
    let ran = false;
    await sql.begin(async (tx) => {
      const [row] = await tx`select pg_try_advisory_xact_lock(hashtextextended(${name}, 0)) as got`;
      if (!row?.got) return; // another invocation holds it: skip, cheap when idle
      ran = true;
      await fn(tx as unknown as TxClient);
    });
    return ran;
  };
}

/**
 * Postgres prune stores (W13 model:prune). Every delete is age-only, the
 * Laravel MassPrunable shape: strictly older than the cutoff goes
 * (`occurred_at`/`created_at < cutoff`), cutoff-exact rows survive. Sessions
 * sweep by expiry (`expires_at <= now`, matching what reads can see).
 */
export function pgPruneStores(sql: TxClient | Sql): PruneStores {
  // Table names cannot be parameterized in postgres.js tagged templates, so
  // each age-pruned table gets its own static statement (same MassPrunable
  // shape as legacy: `... where <age column> < ${cutoff}`).
  const accessLog: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      (await sql`delete from member_data_access_logs where occurred_at < ${cutoff} returning 1`).length,
  };
  const joinAttempts: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      (await sql`delete from join_attempts where created_at < ${cutoff} returning 1`).length,
  };
  const idempotencyKeys: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      (await sql`delete from agent_event_idempotency_keys where created_at < ${cutoff} returning 1`).length,
  };
  const searchLog: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      (await sql`delete from event_search_logs where occurred_at < ${cutoff} returning 1`).length,
  };
  return {
    accessLog,
    joinAttempts,
    idempotencyKeys,
    searchLog,
    sessions: createPostgresSessionStore(sql as unknown as SessionSql),
  };
}

/** ShouldBeUnique lock with TTL (Cache::lock equivalent). Atomic: one upsert that only wins over expired rows. */
export function pgUniqueLock(sql: TxClient | Sql): UniqueLock {
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
 * N3 (TOG-9895): the Postgres side of the queue ledger. Cloudflare Queues is the
 * transport and exposes no depth API, so this ledger is the `jobs` table of the
 * port — the rows `pgQueueDepth` counts for GET /up. Dispatch writes through
 * `trackingQueue`; the consumer calls the rest.
 */
export function pgQueueLedger(sql: Sql | postgres.TransactionSql): QueueLedger {
  return {
    async enqueued({ jobId, kind, key, availableAt }) {
      // One row per accepted transport message. `job_id` is the primary key
      // (minted per dispatch), so each live message keeps its own transitions
      // even when a retry delay (up to 3600s) outlives the 300s uniqueness
      // window and a second dispatch of the same event key lands while the
      // first message is still delayed or reserved. (An earlier key-upsert
      // collapsed that case to one row and lost the first message.)
      //
      // No sweep: an age test cannot tell a transport-paused backlog from an
      // orphan — a compensating-delete row and a still-queued message look
      // identical in this table (no pickup receipt exists on the ledger side).
      // Deleting by age undercounts live depth (TOG-9895 review: 21 accepted
      // reported 20/healthy). Stale rows, if any, stay visible as backlog
      // until the consumer settles them; /up reports, never deletes.
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
      const record = async (tx: postgres.TransactionSql) => {
        await tx`
          insert into queue_failed_jobs (job_id, kind, key, reason)
          values (${jobId}::uuid, ${kind}, ${key}, ${reason.slice(0, 2000)})`;
        await tx`delete from queue_jobs where job_id = ${jobId}::uuid`;
      };
      // Scheduled dispatch already owns a transaction; consumer calls own one.
      if ("begin" in sql) await sql.begin(record);
      else await sql.savepoint(record);
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
