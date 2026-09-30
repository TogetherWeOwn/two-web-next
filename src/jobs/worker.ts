import postgres from "postgres";
import type { Env, JobsEnv } from "../env";
import { databaseOptions, databaseUrl } from "../db/connection";
import { migrate as migrateSessions, type Sql as SessionSql } from "../sessions";
import { pruneModelTables, reconcileEvents, runScheduled } from "./cron";
import { consume } from "./consumer";
import { trackingQueue } from "./ledger";
import { pgPruneStores, pgQueueLedger, pgSingleFlight, pgUniqueLock } from "./postgres";
import type { BotClient, QueueMessage } from "./types";
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

function sqlFor(env: Env & { HYPERDRIVE?: Hyperdrive }) {
  // The wrangler hyperdrive binding is `DB` (S1); `HYPERDRIVE` stays as an
  // accepted alias for environments that predate it.
  const url = databaseUrl(env) || env.HYPERDRIVE?.connectionString;
  if (!url) throw new Error("no database configured (DATABASE_URL or DB/HYPERDRIVE)");
  return postgres(url, databaseOptions);
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

export async function handleQueue(batch: MessageBatch<unknown>, env: JobsEnv): Promise<void> {
  const sql = sqlFor(env);
  // Best-effort ledger I/O gets its own connection. A ledger statement wedged
  // on a row/table lock holds only this client, so the consumer's bounded (2s)
  // ledger timers can expire while lock/handler traffic proceeds on `sql` and
  // every message still reaches ack/retry. Sharing one max:1 pool stalled ack
  // behind an un-cancellable ledger UPDATE (TOG-9895 review).
  const ledgerSql = sqlFor(env);
  try {
    const lock = pgUniqueLock(sql);
    await consume(batch, { bot, events: pgEventStore(sql), lock, ledger: pgQueueLedger(ledgerSql),
      dispatchPending: (eventKey, signal) => dispatchSyncEvent(
        trackingQueue(env.SYNC_EVENT_QUEUE, pgQueueLedger(ledgerSql), undefined, signal), lock, eventKey, undefined, signal),
    });
  } finally {
    // A wedged ledger statement must not hold the invocation open: force-close
    // past the timeout; the main client closes normally.
    await ledgerSql.end({ timeout: 1 }).catch(() => {});
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
      // Prune queries use the reserved client (outer max:1 pool would deadlock).
      // Reconcile's dispatch side effects use an independent autocommit pool.
      reconcile: (db) => reconcileEvents({
        events: pgEventStore(db),
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
