import { alertScheduledFailing, exceptionClass } from "../alerts";
import {
  AGENT_EVENT_AUDIT_RETENTION_DAYS,
  BOARD_VIEW_LOG_RETENTION_DAYS,
  EVENT_SEARCH_LOG_RETENTION_DAYS,
  IDEMPOTENCY_KEY_RETENTION_DAYS,
  JOIN_ATTEMPT_RETENTION_DAYS,
  MEMBER_ACCESS_LOG_RETENTION_DAYS,
  PRUNE_CRON,
  PRUNE_DELETE_BATCH_SIZE,
  PRUNE_DELETE_MAX_BATCHES,
  RECONCILE_CRON,
  RECONCILE_REDISPATCH_PAGE_SIZE,
  SYNC_EVENT,
} from "./constants";
import { dispatchSyncEvent } from "./sync-event";
import type {
  EventStore,
  PruneIsolation,
  PruneStores,
  StaleEventKeysPage,
  TxClient,
  UniqueLock,
} from "./types";

/**
 * Advisory-lock runner: re-expresses onOneServer + withoutOverlapping.
 * Returns false when skipped. The body receives the reserved transaction
 * client for transaction-local queries: the pool is `max: 1`, so a body
 * query on the outer pool waits for the connection the flight itself holds.
 * Dispatch side effects that must commit before an external queue send use
 * an independent client, never this transaction or its outer pool.
 */
export type SingleFlight = (name: string, fn: (db: TxClient) => Promise<void>) => Promise<boolean>;

type ReconcilePreparation = {
  closed: number;
  materialized: number;
  stale: string[] | StaleEventKeysPage;
};

/**
 * Ports events:reconcile: close finished, materialise series, re-dispatch stale. Close first so the
 * sync pass cannot resurrect an ended event; materialise before the sync pass so a new occurrence is
 * picked up in the same run (new occurrences are drafts, which the stale query never returns).
 * Each pass redispatches at most one RECONCILE_REDISPATCH_PAGE_SIZE page in
 * the store's order; deferred leftovers stay stale for the next pass.
 * `resynced` counts only transport-accepted dispatches; unique-lock
 * absorptions report as `absorbed`. One throwing key counts as `failed` and
 * never starves the rest of the pass.
 */
export async function reconcileEvents(deps: {
  events: EventStore;
  queue: { send(b: unknown, o?: { delaySeconds?: number }): Promise<unknown> };
  lock: UniqueLock;
  now?: () => Date;
  writeTransaction?: (
    work: (events: EventStore) => Promise<ReconcilePreparation>,
  ) => Promise<ReconcilePreparation>;
}): Promise<{
  closed: number;
  materialized: number;
  resynced: number;
  absorbed: number;
  failed: number;
  deferred: number;
}> {
  const prepare = async (events: EventStore): Promise<ReconcilePreparation> => ({
    closed: await events.closeFinished((deps.now ?? (() => new Date()))()),
    materialized: await events.materializeSeries(),
    stale: await events.staleEventKeys(RECONCILE_REDISPATCH_PAGE_SIZE),
  });
  // Commit materialization and release parent row locks before external I/O.
  // The enclosing flight still excludes another scheduler throughout dispatch.
  const { closed, materialized, stale } = await (deps.writeTransaction
    ? deps.writeTransaction(prepare)
    : prepare(deps.events));
  // Legacy array answers (and dual-shaped doubles) carry no remainder; a
  // page object carries its deferred count. Either way the pass dispatches
  // at most one page, in the store's order, and leaves the rest stale.
  // Note: plain arrays expose Array.prototype.keys, so the page check must
  // look for an OWN `keys` property — dual-shaped doubles set one, legacy
  // arrays do not. (`deferred` has no prototype clash.)
  const ownPage = Object.hasOwn(stale, "keys")
    ? (stale as unknown as StaleEventKeysPage)
    : undefined;
  const keys = [...(ownPage?.keys ?? (stale as unknown as string[]))];
  const deferred = Array.isArray(stale)
    ? ((stale as unknown as Partial<StaleEventKeysPage>).deferred ?? 0)
    : stale.deferred;
  let resynced = 0;
  let absorbed = 0;
  let failed = 0;
  let firstError: unknown;
  for (const key of keys) {
    try {
      // A carrier can be stranded, delayed or exhausted. Only recover a due
      // request with budget left, always under its original immutable key.
      const pending = await deps.events.pendingSync(key);
      if (
        pending &&
        (pending.requestAttempts >= SYNC_EVENT.tries ||
          !pending.nextAttemptAt ||
          pending.nextAttemptAt > (deps.now ?? (() => new Date()))())
      )
        continue;
      const accepted = await dispatchSyncEvent(deps.queue, deps.lock, key, pending?.idempotencyKey);
      if (accepted) resynced++;
      else absorbed++;
    } catch (err) {
      // One poison key must not starve the rest of the pass. Keep the first
      // error for a total-outage rethrow below; log the key with only its
      // redacted class (DB messages can carry bound values).
      failed++;
      firstError ??= err;
      console.warn("Event reconcile key failed.", { key, error_class: exceptionClass(err) });
    }
  }
  // A fully failed multi-key pass is a systemic outage (queue/DB down), not a
  // single poison key: rethrow so handleScheduled still emits its
  // scheduled.failing page for events:reconcile. A single failed key keeps
  // resolving per the acceptance pin (failed-only single-key pass logs once).
  if (failed > 1 && resynced + absorbed === 0) throw firstError;
  if (
    closed > 0 ||
    materialized > 0 ||
    resynced > 0 ||
    absorbed > 0 ||
    failed > 0 ||
    deferred > 0
  ) {
    console.info("Event reconcile pass completed.", {
      closed,
      materialized,
      resynced,
      absorbed,
      failed,
      deferred,
    });
  }
  return { closed, materialized, resynced, absorbed, failed, deferred };
}

export type PruneCounts = {
  agentEventAudits: number;
  accessLog: number;
  joinAttempts: number;
  idempotencyKeys: number;
  searchLog: number;
  boardViews: number;
  sessions: number;
  jobUniqueLocks: number;
};

const cutoff = (now: Date, days: number): Date => new Date(now.getTime() - days * 86_400_000);

/**
 * Ports model:prune daily ×3 (routes/console.php) plus the web_sessions expiry
 * sweep (no legacy equivalent — Laravel GC; rows accumulate without one) and
 * the job_unique_locks expiry sweep (expired leases linger without one).
 * Age deletes are age-only (Laravel MassPrunable shape): strictly older than
 * the cutoff goes, cutoff-exact rows survive. The session and lock sweeps
 * delete by expiry (`expires_at <= now`, matching what reads see for sessions
 * and the documented sweep contract for locks): expiry-exact rows go, live
 * rows stay. Each statement deletes at most
 * PRUNE_DELETE_BATCH_SIZE rows; the pass repeats the statement per table until
 * an empty batch proves the backlog drained, stopping after
 * PRUNE_DELETE_MAX_BATCHES batches so the single-flight is never held
 * forever. A short non-empty batch is not drained proof: a `SKIP LOCKED`
 * candidate window can hide unvisited unlocked rows behind lock-held ones,
 * so the pass keeps draining within the budget instead of reporting exact
 * totals for a half-visited table. Idempotent: a re-run matches nothing and
 * reports zeros.
 *
 * The worker runs the lock sweep on its autocommit dispatch pool rather than
 * the flight transaction (the sweep deletes the exact rows acquire targets;
 * inside the flight its row locks would be held until the whole pass commits
 * and block concurrent acquires). Either client satisfies the stores shape.
 */

async function drainPruneTable(
  prune: (cutoff: Date) => Promise<number>,
  cutoffDate: Date,
  isolate?: PruneIsolation["isolate"],
): Promise<{ total: number; capped: boolean }> {
  // One boundary for the whole table, not one subtransaction per batch. Use
  // the scope's client for every query so a late failure rolls back the early
  // batches without poisoning the flight's postgres.js error tracking.
  if (isolate) return isolate((scopedPrune) => drainPruneTable(scopedPrune, cutoffDate));
  let total = 0;
  let last = 0;
  for (let i = 0; i < PRUNE_DELETE_MAX_BATCHES; i++) {
    const n = await prune(cutoffDate);
    total += n;
    // Only an empty batch proves the table drained. A short non-empty batch
    // may mean a SKIP LOCKED candidate window skipped lock-held rows while
    // unlocked rows sit unvisited beyond it, so keep draining same-pass.
    if (n === 0) return { total, capped: false };
    last = n;
  }
  // Budget exhausted. A full final batch means rows may still be pending, so
  // report capped. A short final batch drained to the ceiling: stop uncapped
  // (the cap-paging contract pins a short final batch as uncapped and silent,
  // and the totals show a full budget of draining work, never a short total
  // presented as a fully drained table).
  return { total, capped: last === PRUNE_DELETE_BATCH_SIZE };
}

/**
 * Cap-hit signal: a full final prune batch means rows may still be pending
 * past the per-pass ceiling, so sustained over-cap inflow would violate
 * retention indefinitely with no page. Only the class reaches the page line
 * (never a message): table names, counts and SQL stay out of it.
 */
export class PruneBatchCapError extends Error {
  constructor() {
    super("prune batch cap hit with rows possibly pending");
    this.name = "PruneBatchCapError";
  }
}

/**
 * One table drain that failed while the rest of the pass settled. `table` is
 * a PruneCounts key in canonical table order; `error` preserves the original
 * rejection identity for whole-flight reporting when no reporter is supplied.
 */
export type PruneTableFailure = { table: keyof PruneCounts; error: unknown };

export async function pruneModelTables(
  stores: PruneStores,
  now: Date = new Date(),
  opts?: {
    reportCap?: (capped: boolean) => void;
    reportFailures?: (failures: readonly PruneTableFailure[]) => void;
  },
): Promise<PruneCounts> {
  // Stores built before the lock sweep carry no sweeper: drain nothing for
  // them instead of throwing, so the rest of the pass keeps its behavior.
  const locks = stores.jobUniqueLocks ?? { sweepExpired: async (_d: Date): Promise<number> => 0 };
  // Sequential per-table drains in canonical order: every started drain
  // settles before the pass reports (never fail-fast), and one table's SQL
  // error never aborts its siblings. Concurrent drains on a single flight
  // transaction interleave savepoints and one rollback destroys its peers,
  // so tables drain one at a time inside the flight while the lock sweep
  // keeps its autocommit dispatch-pool boundary (see worker.ts). A failed
  // table contributes 0: partial batches from a failed drain are rolled back
  // (or discarded) and must never surface as successful-looking counts.
  const failures: PruneTableFailure[] = [];
  let agentEventAudits = { total: 0, capped: false };
  try {
    agentEventAudits = await drainPruneTable(
      (c) => stores.agentEventAudits.pruneOlderThan(c),
      cutoff(now, AGENT_EVENT_AUDIT_RETENTION_DAYS),
      stores.agentEventAudits.isolate,
    );
  } catch (error) {
    failures.push({ table: "agentEventAudits", error });
  }
  let accessLog = { total: 0, capped: false };
  try {
    accessLog = await drainPruneTable(
      (c) => stores.accessLog.pruneOlderThan(c),
      cutoff(now, MEMBER_ACCESS_LOG_RETENTION_DAYS),
      stores.accessLog.isolate,
    );
  } catch (error) {
    failures.push({ table: "accessLog", error });
  }
  let joinAttempts = { total: 0, capped: false };
  try {
    joinAttempts = await drainPruneTable(
      (c) => stores.joinAttempts.pruneOlderThan(c),
      cutoff(now, JOIN_ATTEMPT_RETENTION_DAYS),
      stores.joinAttempts.isolate,
    );
  } catch (error) {
    failures.push({ table: "joinAttempts", error });
  }
  let idempotencyKeys = { total: 0, capped: false };
  try {
    idempotencyKeys = await drainPruneTable(
      (c) => stores.idempotencyKeys.pruneOlderThan(c),
      cutoff(now, IDEMPOTENCY_KEY_RETENTION_DAYS),
      stores.idempotencyKeys.isolate,
    );
  } catch (error) {
    failures.push({ table: "idempotencyKeys", error });
  }
  let searchLog = { total: 0, capped: false };
  try {
    searchLog = await drainPruneTable(
      (c) => stores.searchLog.pruneOlderThan(c),
      cutoff(now, EVENT_SEARCH_LOG_RETENTION_DAYS),
      stores.searchLog.isolate,
    );
  } catch (error) {
    failures.push({ table: "searchLog", error });
  }
  let boardViews = { total: 0, capped: false };
  try {
    boardViews = await drainPruneTable(
      (c) => stores.boardViews.pruneOlderThan(c),
      cutoff(now, BOARD_VIEW_LOG_RETENTION_DAYS),
      stores.boardViews.isolate,
    );
  } catch (error) {
    failures.push({ table: "boardViews", error });
  }
  let sessions = { total: 0, capped: false };
  try {
    const isolate = stores.sessions.isolate;
    sessions = await drainPruneTable((d) => stores.sessions.sweepExpired(d), now, isolate);
  } catch (error) {
    failures.push({ table: "sessions", error });
  }
  let jobUniqueLocks = { total: 0, capped: false };
  try {
    jobUniqueLocks = await drainPruneTable((d) => locks.sweepExpired(d), now, locks.isolate);
  } catch (error) {
    failures.push({ table: "jobUniqueLocks", error });
  }
  const counts = {
    agentEventAudits: agentEventAudits.total,
    accessLog: accessLog.total,
    joinAttempts: joinAttempts.total,
    idempotencyKeys: idempotencyKeys.total,
    searchLog: searchLog.total,
    boardViews: boardViews.total,
    sessions: sessions.total,
    jobUniqueLocks: jobUniqueLocks.total,
  };
  const cappedTables = (
    [
      ["agentEventAudits", agentEventAudits.capped],
      ["accessLog", accessLog.capped],
      ["joinAttempts", joinAttempts.capped],
      ["idempotencyKeys", idempotencyKeys.capped],
      ["searchLog", searchLog.capped],
      ["boardViews", boardViews.capped],
      ["sessions", sessions.capped],
      ["jobUniqueLocks", jobUniqueLocks.capped],
    ] as const
  )
    .filter(([, capped]) => capped)
    .map(([name]) => name);
  const capped = cappedTables.length > 0;
  if (jobUniqueLocks.capped) {
    // Lock-table cap observability: the lock sweep is a new table the
    // paging contract predates, and its acceptance pins a warn with the
    // capped-table list. Other-table caps stay warn-free per the paging
    // acceptance; the pass still pages once via the redacted signal below.
    console.warn("Model prune pass hit per-table batch cap with rows possibly pending.", {
      ...counts,
      cappedTables,
    });
  }
  // Scheduled path (worker.ts): report the cap without paging inside the
  // advisory-lock transaction. The caller pages after the flight commits, so
  // a commit failure after a capped drain cannot leave a cap page muting the
  // real failure page (both share the Tail mute key
  // scheduled.failing@model:prune).
  opts?.reportCap?.(capped);
  if (failures.length > 0) {
    // Partial failure: every drain already settled above, healthy counts and
    // the cap signal stay exact, and a failed table reports 0 (its partial
    // batches are rolled back or discarded, never successful-looking). The
    // pass itself never pages and never logs success: the scheduled caller
    // pages once post-commit with the failure class, which beats the cap
    // page when both land in one pass.
    opts?.reportFailures?.(failures);
    if (opts?.reportFailures !== undefined) return counts;
    // Existing direct callers without the reporter keep whole-flight failure
    // reporting: settle-all, then reject with the canonical-first error.
    throw failures[0]!.error;
  }
  const deferred = opts?.reportCap !== undefined;
  if (capped && !deferred) {
    // Page once per capped pass instead of warning: sustained over-cap
    // inflow would otherwise violate retention indefinitely with no page.
    // The line is redacted to the scheduled.failing shape (no tables,
    // counts or messages); the pass still returns its counts and never
    // throws on a cap hit.
    try {
      alertScheduledFailing("model:prune", new PruneBatchCapError());
    } catch {
      // A throwing alert sink must not change the counts or fail the pass.
    }
  } else if (!capped && Object.values(counts).some((n) => n > 0))
    console.info("Model prune pass completed.", counts);
  return counts;
}

/** Route a Cron Trigger by its expression. Unknown crons throw (fail loudly). */
export async function runScheduled(
  cron: string,
  flight: SingleFlight,
  jobs: {
    reconcile: (db: TxClient) => Promise<unknown>;
    prune: (db: TxClient) => Promise<unknown>;
  },
): Promise<boolean> {
  if (cron === RECONCILE_CRON)
    return flight("events:reconcile", async (db) => void (await jobs.reconcile(db)));
  if (cron === PRUNE_CRON) return flight("model:prune", async (db) => void (await jobs.prune(db)));
  throw new Error(`unknown cron trigger: ${cron}`);
}
