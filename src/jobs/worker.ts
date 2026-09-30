import postgres from "postgres";
import type { JobsEnv } from "../env";
import { pruneAccessLog, reconcileEvents, runScheduled } from "./cron";
import { consume } from "./consumer";
import { trackingQueue } from "./ledger";
import { pgQueueLedger, pgSingleFlight, pgUniqueLock } from "./postgres";
import type { AccessLogStore, BotClient, EventStore } from "./types";

// The events/access-log tables (W8/W7) and the Rust bot client (ADR pending) do not exist yet. Until
// they do these adapters refuse loudly: a queue message must retry, never be acked as done by a stub.
const notWired = (what: string) => () => Promise.reject(new Error(`${what} not wired yet`));
const events: EventStore = {
  find: notWired("EventStore.find"),
  recordMirrored: notWired("EventStore.recordMirrored"),
  closeFinished: notWired("EventStore.closeFinished"),
  staleEventKeys: notWired("EventStore.staleEventKeys"),
};
const accessLog: AccessLogStore = { pruneOlderThan: notWired("AccessLogStore.pruneOlderThan") };
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
  try {
    await consume(batch, { bot, events, lock: pgUniqueLock(sql), ledger: pgQueueLedger(sql) });
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export async function handleScheduled(controller: ScheduledController, env: JobsEnv): Promise<void> {
  const sql = sqlFor(env);
  try {
    const lock = pgUniqueLock(sql);
    const ledger = pgQueueLedger(sql);
    await runScheduled(controller.cron, pgSingleFlight(sql), {
      // The tracking wrapper writes the `queue_jobs` row on dispatch, so /up sees
      // every re-dispatched stale event the moment it is queued.
      reconcile: () => reconcileEvents({ events, queue: trackingQueue(env.SYNC_EVENT_QUEUE, ledger), lock }),
      prune: () => pruneAccessLog(accessLog),
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}
