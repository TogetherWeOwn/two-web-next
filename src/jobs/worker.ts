import postgres from "postgres";
import type { Env, JobsEnv } from "../env";
import { databaseOptions, databaseUrl } from "../db/connection";
import { qaEnabled } from "../qa";
import { migrate as migrateSessions, type Sql as SessionSql } from "../sessions";
import { pruneModelTables, reconcileEvents, runScheduled } from "./cron";
import { consume } from "./consumer";
import { trackingQueue } from "./ledger";
import { pgPruneStores, pgQueueLedger, pgSingleFlight, pgUniqueLock } from "./postgres";
import type { BotClient, QueueLedger, QueueMessage, UniqueLock } from "./types";
import { dispatchSyncEvent } from "./sync-event";
import { pgEventStore } from "./events";

// The Rust bot client is a later slice. Refuse loudly rather than ack a stub
// as success; this slice wires the carrier and current-row event store only.
const notWired = (what: string) => () => Promise.reject(new Error(`${what} not wired yet`));
const bot: BotClient = {
  upsertEvent: notWired("BotClient.upsertEvent"),
  cancelEvent: notWired("BotClient.cancelEvent"),
  postAnnouncement: notWired("BotClient.postAnnouncement"),
  assignRole: notWired("BotClient.assignRole"),
};

function sqlFor(env: Env & { HYPERDRIVE?: Hyperdrive }, options: postgres.Options<{}> = databaseOptions) {
  // The wrangler hyperdrive binding is `DB` (S1); `HYPERDRIVE` stays as an
  // accepted alias for environments that predate it.
  const url = databaseUrl(env) || env.HYPERDRIVE?.connectionString;
  if (!url) throw new Error("no database configured (DATABASE_URL or DB/HYPERDRIVE)");
  return postgres(url, options);
}

// A successor can outlive consume's 2s deadline and all three handler pools.
// Open only for an individual SQL operation, never across queue I/O. In
// particular, rejected-late compensation gets a usable new pool, not an ended
// ledgerSql. A blocked INSERT can finish late, observe the aborted signal and
// compensate without occupying the next message's ledger/handler connection.
async function successorSql<T>(env: JobsEnv, work: (sql: ReturnType<typeof sqlFor>) => Promise<T>): Promise<T> {
  const sql = sqlFor(env, { ...databaseOptions, connect_timeout: 2,
    connection: { statement_timeout: 5000 } });
  try { return await work(sql); }
  finally { await sql.end({ timeout: 1 }).catch(() => {}); }
}

// waitUntil keeps settlement runnable after ACK/return, but cannot promise
// arbitrarily late transport results. Bound our extension to 30s; never delete
// a row merely because a send has not settled (it may already be accepted).
function successorLifetime(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn("sync successor settlement lifetime expired; unsettled ledger rows remain tracked");
      resolve();
    }, 30_000);
  });
  return Promise.race([work.then(() => {}, () => {}), timeout]).finally(() => clearTimeout(timer));
}

/** Web after-commit producer, sharing reconciliation's ledger and unique lock. */
export async function enqueueSyncEvent(env: Env, message: Extract<QueueMessage, { kind: "sync-event" }>): Promise<boolean> {
  if (!env.SYNC_EVENT_QUEUE) throw new Error("SYNC_EVENT_QUEUE is not bound");
  // Autocommit: ledger and lock must be visible before the transport accepts.
  const sql = sqlFor(env);
  try {
    return await dispatchSyncEvent(
      trackingQueue(env.SYNC_EVENT_QUEUE, pgQueueLedger(sql)),
      pgUniqueLock(sql), message.eventKey, message.idempotencyKey,
    );
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export async function handleQueue(batch: MessageBatch<unknown>, env: JobsEnv, ctx?: ExecutionContext): Promise<void> {
  const sql = sqlFor(env);
  // Promise.race bounds waiting, not SQL execution. Isolate all best-effort
  // ledger/lock traffic from the max:1 handler pool: a timed-out statement can
  // remain blocked without starving the next message's snapshot.
  const ledgerSql = sqlFor(env);
  const cleanupSql = sqlFor(env);
  try {
    const ledger = pgQueueLedger(ledgerSql);
    const successorLedger: QueueLedger = { ...ledger,
      enqueued: (job) => successorSql(env, (sql) => pgQueueLedger(sql).enqueued(job)),
      dequeued: (jobId) => successorSql(env, (sql) => pgQueueLedger(sql).dequeued(jobId)),
    };
    const successorLock: UniqueLock = {
      acquire: (key, ttl) => successorSql(env, (sql) => pgUniqueLock(sql).acquire(key, ttl)),
      release: (key, leaseToken) => successorSql(env, (sql) => pgUniqueLock(sql).release(key, leaseToken)),
    };
    await consume(batch, { bot, events: pgEventStore(sql), lock: pgUniqueLock(cleanupSql), ledger,
      needsSync: pgEventStore(cleanupSql).needsSync,
      dispatchPending: (eventKey, signal) => {
        const work = dispatchSyncEvent(
          trackingQueue(env.SYNC_EVENT_QUEUE, successorLedger, undefined, signal),
          successorLock, eventKey, undefined, signal);
        ctx?.waitUntil(successorLifetime(work));
        return work;
      },
      probeEnabled: qaEnabled(env.APP_URL, env.QA_AUTH_TOKEN),
    });
  } finally {
    // Force-close timed-out best-effort SQL without holding the invocation open.
    await Promise.all([
      ledgerSql.end({ timeout: 1 }).catch(() => {}),
      cleanupSql.end({ timeout: 1 }).catch(() => {}),
    ]);
    await sql.end({ timeout: 1 });
  }
}

export async function handleScheduled(controller: ScheduledController, env: JobsEnv): Promise<void> {
  const sql = sqlFor(env);
  // Dispatch commits its ledger row and uniqueness lock before the external
  // queue send. A later reconciliation rollback must not erase accepted jobs,
  // and an early consumer must see and settle the committed rows.
  const dispatchSql = sqlFor(env);
  try {
    // web_sessions is runtime-DDL-only (no drizzle migration owns it); only
    // the web path runs migrate(). A prune before any web traffic would fail
    // the whole pass on a missing table, so ensure it here too (no-op when
    // already migrated). Outside the flight: DDL must not run inside the
    // advisory-lock transaction.
    await migrateSessions(sql as unknown as SessionSql);
    await runScheduled(controller.cron, pgSingleFlight(sql), {
      // The reserved flight holds only the scheduler advisory lock during
      // dispatch. Event writes have a shorter transaction on the other pool,
      // so parent row locks are released before unrelated external sends.
      reconcile: () => reconcileEvents({
        events: pgEventStore(dispatchSql),
        writeTransaction: (work) => dispatchSql.begin(async (tx) => work(pgEventStore(tx))),
        queue: trackingQueue(env.SYNC_EVENT_QUEUE, pgQueueLedger(dispatchSql)),
        lock: pgUniqueLock(dispatchSql),
      }),
      prune: (db) => pruneModelTables(pgPruneStores(db)),
    });
  } finally {
    await dispatchSql.end({ timeout: 1 }).catch(() => {});
    await sql.end({ timeout: 1 });
  }
}
