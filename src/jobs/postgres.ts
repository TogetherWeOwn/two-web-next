import type postgres from "postgres";
import { PRUNE_DELETE_BATCH_SIZE } from "./constants";
import type { SingleFlight } from "./cron";
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
 * Postgres prune stores (W13 model:prune). Every age delete is age-only, the
 * Laravel MassPrunable shape: strictly older than the cutoff goes
 * (`occurred_at`/`created_at < cutoff`), cutoff-exact rows survive. The
 * scheduled session and unique-lock adapters each delete at most
 * PRUNE_DELETE_BATCH_SIZE expired rows per statement, and only rows expired
 * by BOTH clocks (`expires_at <= now` AND `expires_at <= clock_timestamp()`,
 * mirroring the audit guard: expiry-exact rows go, live rows stay,
 * caller-ahead skew rows are skipped); the scheduled pass drains each via
 * `drainPruneTable`. The general session store's `sweepExpired` keeps its
 * existing full-drain contract for non-scheduled callers.
 *
 * Every candidate select takes its rows `FOR UPDATE SKIP LOCKED`: an eligible
 * row locked by an unrelated transaction is skipped instead of stalling the
 * statement, so one held row defers to a later pass while unlocked rows in
 * every table still delete and commit. Batch bounds, cutoffs, guards and
 * exact counts are unchanged.
 */
export function pgPruneStores(sql: TxClient | Sql): PruneStores {
  // Table names cannot be parameterized in postgres.js tagged templates, so
  // each age-pruned table gets its own static statement (same MassPrunable
  // shape as legacy: `... where <age column> < ${cutoff}`).
  // Append-only audit rows (drizzle/1018): the database refuses to delete one
  // unless it is strictly older than 90 days by its own clock. A caller clock
  // running ahead must skip, not raise on, the rows in between.
  //
  // Transaction isolation: bound to a flight transaction client, each
  // statement runs inside a real PostgreSQL savepoint boundary so one
  // table-specific SQL error rolls back only that statement and rethrows
  // without aborting the enclosing flight (the pass drains tables
  // sequentially, so savepoints never interleave). Bound to a pool
  // (autocommit, no savepoint surface) the same statements run as before —
  // the lock sweep's autocommit boundary is unchanged.
  const withSavepoint = <T>(work: (client: TxClient | Sql) => Promise<T>): Promise<T> => {
    const candidate = sql as unknown as {
      savepoint?: (fn: (client: TxClient | Sql) => Promise<T>) => Promise<T>;
    };
    if (typeof candidate.savepoint === "function") return candidate.savepoint((c) => work(c));
    return work(sql);
  };
  const agentEventAudits: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      withSavepoint(
        async (client) =>
          (
            await client`delete from agent_event_audits where id in (
          select id from agent_event_audits where created_at < ${cutoff}
            and created_at < clock_timestamp() - interval '2160 hours'
          order by id limit ${PRUNE_DELETE_BATCH_SIZE}
          for update skip locked
        ) returning 1`
          ).length,
      ),
  };
  const accessLog: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      withSavepoint(
        async (client) =>
          (
            await client`delete from member_data_access_logs where id in (
          select id from member_data_access_logs where occurred_at < ${cutoff}
            and occurred_at < clock_timestamp() - interval '2160 hours'
          order by id limit ${PRUNE_DELETE_BATCH_SIZE}
          for update skip locked
        ) returning 1`
          ).length,
      ),
  };
  const joinAttempts: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      withSavepoint(
        async (client) =>
          (
            await client`delete from join_attempts where id in (
          select id from join_attempts where created_at < ${cutoff}
          order by id limit ${PRUNE_DELETE_BATCH_SIZE}
          for update skip locked
        ) returning 1`
          ).length,
      ),
  };
  const idempotencyKeys: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      withSavepoint(
        async (client) =>
          (
            await client`delete from agent_event_idempotency_keys where id in (
          select id from agent_event_idempotency_keys where created_at < ${cutoff}
          order by id limit ${PRUNE_DELETE_BATCH_SIZE}
          for update skip locked
        ) returning 1`
          ).length,
      ),
  };
  const searchLog: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      withSavepoint(
        async (client) =>
          (
            await client`delete from event_search_logs where id in (
          select id from event_search_logs where occurred_at < ${cutoff}
          order by id limit ${PRUNE_DELETE_BATCH_SIZE}
          for update skip locked
        ) returning 1`
          ).length,
      ),
  };
  const boardViews: AgePrunedTable = {
    pruneOlderThan: async (cutoff) =>
      withSavepoint(
        async (client) =>
          (
            await client`delete from board_view_logs where id in (
          select id from board_view_logs where occurred_at < ${cutoff}
          order by id limit ${PRUNE_DELETE_BATCH_SIZE}
          for update skip locked
        ) returning 1`
          ).length,
      ),
  };
  // Scheduled session adapter: per-statement bounded expiry sweep. Deletes
  // only rows expired by BOTH clocks — `expires_at <= now` (the read-visibility
  // predicate: expiry-exact rows go, live rows stay) AND expired by the
  // database's own clock at statement time (`expires_at <= clock_timestamp()`),
  // mirroring the audit-table guard above. A caller clock running ahead skips
  // the skew-window rows instead of over-deleting them, and never raises; a
  // caller clock running behind stays caller-bounded (AND, not DB-clock-only).
  // Deletes at most one batch per statement; the cron pass drains via
  // `drainPruneTable` and reports exact totals plus the cap.
  const sessions = {
    sweepExpired: async (now: Date) =>
      withSavepoint(
        async (client) =>
          (
            await client`delete from web_sessions where token_hash in (
          select token_hash from web_sessions where expires_at <= ${now}
            and expires_at <= clock_timestamp()
          order by token_hash limit ${PRUNE_DELETE_BATCH_SIZE}
          for update skip locked
        ) returning 1`
          ).length,
      ),
  };
  // Expired unique-lock sweep: per-statement bounded expiry delete. Uses the
  // scheduled session-sweep expiry predicate: only rows expired by BOTH
  // clocks (`expires_at <= now` AND `expires_at <= clock_timestamp()`).
  // Expiry-exact rows go, live leases stay, and a caller clock running ahead
  // skips the skew-window rows instead of deleting leases acquire (which
  // answers the database clock: `expires_at < clock_timestamp()`) still
  // honors. Deletes at most one batch per statement; the cron pass drains via
  // `drainPruneTable`.
  //
  // The outer DELETE rechecks both expiry predicates (not just candidate
  // keys): under READ COMMITTED a concurrent acquire that renews a swept
  // candidate between the subquery snapshot and the delete would otherwise
  // still match on key alone and delete the live lease. The recheck makes the
  // renewed row fail the predicate after the row-lock wait instead.
  const jobUniqueLocks = {
    sweepExpired: async (now: Date) =>
      withSavepoint(
        async (client) =>
          (
            await client`delete from job_unique_locks where expires_at <= ${now}
          and expires_at <= clock_timestamp() and key in (
          select key from job_unique_locks where expires_at <= ${now}
            and expires_at <= clock_timestamp()
          order by key limit ${PRUNE_DELETE_BATCH_SIZE}
          for update skip locked
        ) returning 1`
          ).length,
      ),
  };
  return {
    agentEventAudits,
    accessLog,
    joinAttempts,
    idempotencyKeys,
    searchLog,
    boardViews,
    sessions,
    jobUniqueLocks,
  };
}

/**
 * ShouldBeUnique TTL uses acquisition time, not transaction-start `now()`.
 * https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT
 * Atomic: one upsert that only wins over expired rows.
 */
export function pgUniqueLock(sql: TxClient | Sql): UniqueLock {
  return {
    async acquire(key, ttlSeconds) {
      const leaseToken = crypto.randomUUID();
      const rows = await sql`
        insert into job_unique_locks (key, expires_at, owner_token)
        values (${key}, clock_timestamp() + make_interval(secs => ${ttlSeconds}), ${leaseToken}::uuid)
        on conflict (key) do update set
          expires_at = clock_timestamp() + make_interval(secs => ${ttlSeconds}),
          owner_token = excluded.owner_token
          where job_unique_locks.expires_at < clock_timestamp()
        returning owner_token`;
      return rows[0]?.owner_token ?? null;
    },
    async release(key, leaseToken) {
      await sql`delete from job_unique_locks where key = ${key} and owner_token = ${leaseToken}::uuid`;
    },
  };
}

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
      await sql.begin("isolation level read committed", async (tx) => {
        // Fence one dispatch even before the additive unique constraint lands.
        // Keep the insert separate: after waiting for the lock, READ COMMITTED
        // takes a fresh snapshot and sees the preceding delivery's commit.
        // https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS
        // https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED
        await tx`select pg_advisory_xact_lock(hashtextextended('queue-failed:' || ${jobId}::uuid::text, 0))`;
        await tx`
          insert into queue_failed_jobs (job_id, kind, key, reason)
          select ${jobId}::uuid, ${kind}, ${key}, ${reason.slice(0, 2000)}
          where not exists (select 1 from queue_failed_jobs where job_id = ${jobId}::uuid)`;
        // A redelivery keeps the first failure, but still retires any live row.
        // Insert errors abort this transaction before delete; none are swallowed.
        await tx`delete from queue_jobs where job_id = ${jobId}::uuid`;
      });
    },
  };
}

/** Ledger counts plus creation age (parity) and current eligibility age (operational). */
export type QueueDepth = {
  pending: number;
  delayed: number;
  reserved: number;
  total: number;
  failed: number;
  oldestPendingAgeSeconds: number | null;
  oldestReadyWaitAgeSeconds: number | null;
};

/**
 * Ports QueueHealth::measure() onto the ledger: one round-trip, the same bucket
 * semantics (pending = available now and unclaimed; delayed = not yet available,
 * counted even when claimed, same as legacy). Throws on driver/table error — the
 * caller maps that to `queue.status: unknown`, never a 500.
 */
export async function pgQueueDepth(sql: Sql | postgres.TransactionSql): Promise<QueueDepth> {
  // Health setup precedes this statement inside a transaction. now() would
  // freeze availability at BEGIN; use one measurement-time clock instead.
  // Ready-wait starts at current available_at, not created_at (retries keep it).
  // Preserve fractional seconds so strict age tripwires never round up/down.
  // https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT
  const [row] = await sql`
    select
      count(*) filter (where available_at <= statement_timestamp() and reserved_at is null)::int as pending,
      count(*) filter (where available_at > statement_timestamp())::int as delayed,
      count(*) filter (where reserved_at is not null)::int as reserved,
      count(*)::int as total,
      (select count(*)::int from queue_failed_jobs) as failed,
      extract(epoch from statement_timestamp() - (min(created_at) filter (where available_at <= statement_timestamp() and reserved_at is null)))::int
        as oldest_pending_age_seconds,
      extract(epoch from statement_timestamp() - (min(available_at) filter (where available_at <= statement_timestamp() and reserved_at is null)))::double precision
        as oldest_ready_wait_age_seconds
    from queue_jobs`;
  if (!row) throw new Error("queue depth query returned no row");
  return {
    pending: row.pending,
    delayed: row.delayed,
    reserved: row.reserved,
    total: row.total,
    failed: row.failed,
    oldestPendingAgeSeconds: row.oldest_pending_age_seconds,
    oldestReadyWaitAgeSeconds: row.oldest_ready_wait_age_seconds,
  };
}
