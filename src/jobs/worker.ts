import postgres from "postgres";
import { qaEnabled } from "../qa";
import type { JobsEnv } from "../env";
import { migrate as migrateSessions, type Sql as SessionSql } from "../sessions";
import { pruneModelTables, reconcileEvents, runScheduled } from "./cron";
import { consume } from "./consumer";
import { pgEventStore } from "./event-store-pg";
import { trackingQueue } from "./ledger";
import { pgPruneStores, pgQueueLedger, pgSingleFlight, pgUniqueLock } from "./postgres";
import type { BotClient } from "./types";

// The Rust bot client (ADR pending) does not exist yet. Until it does this
// adapter refuses loudly: a queue message must retry, never be acked as done
// by a stub. The EventStore below is the real pg adapter (TOG-11660); an
// unconfigured DB still fails loudly out of sqlFor, never acks.
const notWired = (what: string) => () => Promise.reject(new Error(`${what} not wired yet`));
const bot: BotClient = {
  upsertEvent: notWired("BotClient.upsertEvent"),
  postAnnouncement: notWired("BotClient.postAnnouncement"),
  assignRole: notWired("BotClient.assignRole"),
};

function sqlFor(env: JobsEnv) {
  // The wrangler hyperdrive binding is `DB` (S1); `HYPERDRIVE` stays as an
  // accepted alias for environments that predate it.
  const url = env.HYPERDRIVE?.connectionString ?? env.DB?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error("no database configured (DB/HYPERDRIVE or DATABASE_URL)");
  return postgres(url, { max: 1 });
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
    await consume(batch, {
      bot,
      events: pgEventStore(sql),
      lock: pgUniqueLock(sql),
      ledger: pgQueueLedger(ledgerSql),
      probeEnabled: qaEnabled(env.APP_URL, env.QA_AUTH_TOKEN),
    });
  } finally {
    // A wedged ledger statement must not hold the invocation open: force-close
    // past the timeout; the main client closes normally.
    await ledgerSql.end({ timeout: 1 }).catch(() => {});
    await sql.end({ timeout: 1 });
  }
}

export async function handleScheduled(
  controller: ScheduledController,
  env: JobsEnv,
): Promise<void> {
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
      // Prune and reconcile-event queries use the reserved client (outer
      // max:1 pool would deadlock). Reconcile's dispatch side effects use an
      // independent autocommit pool.
      reconcile: (db) =>
        reconcileEvents({
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
