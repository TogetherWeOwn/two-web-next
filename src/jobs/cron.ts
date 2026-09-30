import {
  EVENT_SEARCH_LOG_RETENTION_DAYS,
  IDEMPOTENCY_KEY_RETENTION_DAYS,
  JOIN_ATTEMPT_RETENTION_DAYS,
  MEMBER_ACCESS_LOG_RETENTION_DAYS,
  PRUNE_CRON,
  RECONCILE_CRON,
} from "./constants";
import { dispatchSyncEvent } from "./sync-event";
import type { EventStore, PruneStores, UniqueLock } from "./types";

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

export type PruneCounts = {
  accessLog: number;
  joinAttempts: number;
  idempotencyKeys: number;
  searchLog: number;
  sessions: number;
};

const cutoff = (now: Date, days: number): Date => new Date(now.getTime() - days * 86_400_000);

/**
 * Ports model:prune daily ×3 (routes/console.php) plus the web_sessions expiry
 * sweep (no legacy equivalent — Laravel GC; rows accumulate without one).
 * Every delete is age-only (Laravel MassPrunable shape): strictly older than
 * the cutoff goes, cutoff-exact rows survive. Idempotent: a re-run matches
 * nothing and reports zeros.
 */
export async function pruneModelTables(stores: PruneStores, now: Date = new Date()): Promise<PruneCounts> {
  const [accessLog, joinAttempts, idempotencyKeys, searchLog, sessions] = await Promise.all([
    stores.accessLog.pruneOlderThan(cutoff(now, MEMBER_ACCESS_LOG_RETENTION_DAYS)),
    stores.joinAttempts.pruneOlderThan(cutoff(now, JOIN_ATTEMPT_RETENTION_DAYS)),
    stores.idempotencyKeys.pruneOlderThan(cutoff(now, IDEMPOTENCY_KEY_RETENTION_DAYS)),
    stores.searchLog.pruneOlderThan(cutoff(now, EVENT_SEARCH_LOG_RETENTION_DAYS)),
    stores.sessions.sweepExpired(now),
  ]);
  const counts = { accessLog, joinAttempts, idempotencyKeys, searchLog, sessions };
  if (Object.values(counts).some((n) => n > 0)) console.info("Model prune pass completed.", counts);
  return counts;
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
