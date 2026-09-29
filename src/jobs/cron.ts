import { MEMBER_ACCESS_LOG_RETENTION_DAYS, PRUNE_CRON, RECONCILE_CRON } from "./constants";
import { dispatchSyncEvent } from "./sync-event";
import type { AccessLogStore, EventStore, UniqueLock } from "./types";

/** Advisory-lock runner: re-expresses onOneServer + withoutOverlapping. Returns false when skipped. */
export type SingleFlight = (name: string, fn: () => Promise<void>) => Promise<boolean>;

/** Ports events:reconcile. Close finished first so the sync pass cannot resurrect an ended event. */
export async function reconcileEvents(deps: {
  events: EventStore;
  queue: { send(b: unknown, o?: { delaySeconds?: number }): Promise<unknown> };
  lock: UniqueLock;
  now?: () => Date;
}): Promise<{ closed: number; resynced: number }> {
  const closed = await deps.events.closeFinished((deps.now ?? (() => new Date()))());
  const stale = await deps.events.staleEventKeys();
  let resynced = 0;
  for (const key of stale) {
    await dispatchSyncEvent(deps.queue, deps.lock, key);
    resynced++; // Laravel counts stale rows, not accepted dispatches
  }
  if (closed > 0 || resynced > 0) console.info("Event reconcile pass completed.", { closed, resynced });
  return { closed, resynced };
}

/** Ports model:prune for MemberDataAccessLog (age-only mass delete). */
export async function pruneAccessLog(store: AccessLogStore, now: Date = new Date()): Promise<number> {
  return store.pruneOlderThan(new Date(now.getTime() - MEMBER_ACCESS_LOG_RETENTION_DAYS * 86_400_000));
}

/** Route a Cron Trigger by its expression. Unknown crons throw (fail loudly). */
export async function runScheduled(
  cron: string,
  flight: SingleFlight,
  jobs: { reconcile: () => Promise<unknown>; prune: () => Promise<unknown> },
): Promise<boolean> {
  if (cron === RECONCILE_CRON) return flight("events:reconcile", async () => void (await jobs.reconcile()));
  if (cron === PRUNE_CRON) return flight("model:prune", async () => void (await jobs.prune()));
  throw new Error(`unknown cron trigger: ${cron}`);
}
