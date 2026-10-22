import postgres from "postgres";
import { alertScheduledFailing, type ScheduledFailingJob } from "../alerts";
import { createBotClient } from "../bot/client";
import type { Env, JobsEnv } from "../env";
import { databaseOptions, databaseUrl } from "../db/connection";
import { setReleaseMetadata } from "../release-tag";
import { qaEnabled } from "../qa";
import { PRUNE_CRON, RECONCILE_CRON } from "./constants";
import {
  PruneBatchCapError,
  ReconcilePartialFailureError,
  pruneModelTables,
  reconcileEvents,
  runScheduled,
  type ReconcilePreparation,
} from "./cron";
import { consume } from "./consumer";
import { trackingQueue } from "./ledger";
import { pgPruneStores, pgQueueLedger, pgSingleFlight, pgUniqueLock } from "./postgres";
import type {
  BotClient,
  EventStore,
  QueueLedger,
  QueueMessage,
  TxClient,
  UniqueLock,
} from "./types";
import { dispatchSyncEvent } from "./sync-event";
import { pgEventStore } from "./events";

/**
 * Live bot transport for the queue consumer. Configuration is checked per call
 * (not at construction), so a missing BOT_* value surfaces as the consumer's
 * terminal BotTerminalError outcome: it alerts and is recorded as failed, and
 * is never acked as a success. Redirects are refused by the client.
 */
export function botClientFor(
  env: Pick<JobsEnv, "BOT_ENDPOINT_URL" | "BOT_KEY_ID" | "BOT_SHARED_SECRET">,
  fetchFn?: typeof fetch,
): BotClient {
  return createBotClient({
    url: env.BOT_ENDPOINT_URL,
    secret: env.BOT_SHARED_SECRET,
    keyId: env.BOT_KEY_ID,
    fetchFn,
  });
}

function sqlFor(
  env: Env & { HYPERDRIVE?: Hyperdrive },
  options: postgres.Options<{}> = databaseOptions,
) {
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
async function successorSql<T>(
  env: JobsEnv,
  work: (sql: ReturnType<typeof sqlFor>) => Promise<T>,
): Promise<T> {
  const sql = sqlFor(env, {
    ...databaseOptions,
    connect_timeout: 2,
    connection: { statement_timeout: 5000 },
  });
  try {
    return await work(sql);
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

// waitUntil keeps settlement runnable after ACK/return, but cannot promise
// arbitrarily late transport results. Bound our extension to 30s; never delete
// a row merely because a send has not settled (it may already be accepted).
function successorLifetime(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        "sync successor settlement lifetime expired; unsettled ledger rows remain tracked",
      );
      resolve();
    }, 30_000);
  });
  return Promise.race([
    work.then(
      () => {},
      () => {},
    ),
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/** Web after-commit producer, sharing reconciliation's ledger and unique lock. */
export async function enqueueSyncEvent(
  env: Env,
  message: Extract<QueueMessage, { kind: "sync-event" }>,
): Promise<boolean> {
  if (!env.SYNC_EVENT_QUEUE) throw new Error("SYNC_EVENT_QUEUE is not bound");
  // Autocommit: ledger and lock must be visible before the transport accepts.
  const sql = sqlFor(env);
  try {
    return await dispatchSyncEvent(
      trackingQueue(env.SYNC_EVENT_QUEUE, pgQueueLedger(sql)),
      pgUniqueLock(sql),
      message.eventKey,
      message.idempotencyKey,
      undefined,
      message.requestId,
    );
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: JobsEnv,
  ctx?: ExecutionContext,
): Promise<void> {
  // Seed before consume() so queue.failing lines carry this Worker's build.
  setReleaseMetadata(env.CF_VERSION_METADATA);
  const sql = sqlFor(env);
  // Promise.race bounds waiting, not SQL execution. Isolate all best-effort
  // ledger/lock traffic from the max:1 handler pool: a timed-out statement can
  // remain blocked without starving the next message's snapshot.
  const ledgerSql = sqlFor(env);
  const cleanupSql = sqlFor(env);
  try {
    const ledger = pgQueueLedger(ledgerSql);
    const successorLedger: QueueLedger = {
      ...ledger,
      enqueued: (job) => successorSql(env, (sql) => pgQueueLedger(sql).enqueued(job)),
      dequeued: (jobId) => successorSql(env, (sql) => pgQueueLedger(sql).dequeued(jobId)),
    };
    const successorLock: UniqueLock = {
      acquire: (key, ttl) => successorSql(env, (sql) => pgUniqueLock(sql).acquire(key, ttl)),
      release: (key, leaseToken) =>
        successorSql(env, (sql) => pgUniqueLock(sql).release(key, leaseToken)),
    };
    await consume(batch, {
      bot: botClientFor(env),
      events: pgEventStore(sql),
      lock: pgUniqueLock(cleanupSql),
      ledger,
      needsSync: pgEventStore(cleanupSql).needsSync,
      dispatchPending: (eventKey, signal) => {
        // Late settlement stays inside Workers lifetime: dispatch rejects at
        // the producer deadline while the underlying acquire/send (and its
        // exact-jobId ledger compensation on fresh successor pools) may still
        // be in flight. The hook fires before dispatch settles, so awaiting
        // the tail here covers it; ACK timing is unchanged (the consumer still
        // races the returned work at its own 2s bound).
        const late: Promise<unknown>[] = [];
        const work = dispatchSyncEvent(
          trackingQueue(env.SYNC_EVENT_QUEUE, successorLedger, undefined, signal),
          successorLock,
          eventKey,
          undefined,
          signal,
          undefined,
          (tail) => {
            late.push(tail);
          },
        );
        ctx?.waitUntil(
          successorLifetime(
            work
              .finally(() => Promise.allSettled(late))
              .then(
                () => {},
                () => {},
              ),
          ),
        );
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
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

// Cron expression to the allowlisted scheduled-job discriminator. Only these
// two jobs emit the scheduled.failing paging signal: sparse invocations that
// can never trip the crash-loop gate on their own. Unknown crons still fail
// loudly but stay silent here.
const SCHEDULED_JOB_FOR_CRON: Record<string, ScheduledFailingJob> = {
  [RECONCILE_CRON]: "events:reconcile",
  [PRUNE_CRON]: "model:prune",
};

/**
 * Server-side budget for the scheduled reconcile prepare transaction
 * (closeFinished + materializeSeries + staleEventKeys). The dispatch pool is
 * `max: 1`, so an unbounded prepare wedges the only scheduler connection for
 * the whole pass while another transaction holds a conflicting row lock. Both
 * budgets name this one 5s constant (the file's own 5s-order precedent from
 * successorSql): a held lock cancels the prepare with 55P03 (or 57014 when
 * the equal statement timer wins the same-instant race; the scheduled path
 * treats both identically), a slow statement with 57014, and the pass fails
 * fast instead of wedging. Transaction-local
 * (`SET LOCAL` via set_config) so pooled session settings never leak to the
 * next holder; the next scheduled pass retries from a clean connection.
 */
export const RECONCILE_PREPARE_DB_TIMEOUT_MS = 5000;

/** Scope the prepare budgets on this transaction, before any EventStore statement. */
export async function setReconcilePrepareTimeouts(client: TxClient | postgres.Sql): Promise<void> {
  await client`select set_config('lock_timeout', ${`${RECONCILE_PREPARE_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${RECONCILE_PREPARE_DB_TIMEOUT_MS}ms`}, true)`;
}

/** Production writeTransaction for the scheduled reconcile pass: the prepare
 * runs in one transaction with the budgets above, on the given pool. */
export function reconcileWriteTransaction(
  sql: postgres.Sql,
): (work: (events: EventStore) => Promise<ReconcilePreparation>) => Promise<ReconcilePreparation> {
  return (work) =>
    sql.begin(async (tx) => {
      await setReconcilePrepareTimeouts(tx);
      return work(pgEventStore(tx));
    });
}

export async function handleScheduled(
  controller: ScheduledController,
  env: JobsEnv,
): Promise<void> {
  setReleaseMetadata(env.CF_VERSION_METADATA);
  // Acquire inside the failure boundary: a setup throw (missing DB config or
  // a throwing driver construction) still pages once for a known cron, and a
  // second-construction failure still closes the first client.
  let sql: ReturnType<typeof sqlFor> | undefined;
  let dispatchSql: ReturnType<typeof sqlFor> | undefined;
  try {
    sql = sqlFor(env);
    // Dispatch commits its ledger row and uniqueness lock before the external
    // queue send. A later reconciliation rollback must not erase accepted jobs,
    // and an early consumer must see and settle the committed rows.
    dispatchSql = sqlFor(env);
    // Narrow once for the closures below: both pools are acquired here, so a
    // later setup throw cannot reach this point with a missing client.
    const sqlClient: ReturnType<typeof sqlFor> = sql;
    const dispatchClient: ReturnType<typeof sqlFor> = dispatchSql;
    // No DDL here (TOG-19721): web_sessions comes from the migrate workflow
    // (drizzle/1022), like every other table the prune pass reads. A database
    // that predates that migration fails the pass like any other outage.
    // The prune cap page fires only after the flight commits. The drains run
    // inside the advisory-lock transaction, and a pre-commit cap page shares
    // the Tail mute key scheduled.failing@model:prune with a later commit
    // failure's page, muting the real failure. A rolled-back pass reports
    // only its real error from the catch below; the next pass re-pages the
    // cap if the backlog is still over the ceiling.
    let pruneCapped = false;
    let pruneFailures: { error: unknown }[] = [];
    // Resolved partial failures: the pass committed with isolated keys failed
    // while healthy keys still dispatched. Reported here (not inside the
    // flight) so the page fires after the flight commits, like the prune-cap
    // precedent: a rolled-back pass pages only its real error from the catch
    // below, and a direct reconcileEvents call stays page-free.
    let reconcilePartialFailures = 0;
    await runScheduled(controller.cron, pgSingleFlight(sqlClient), {
      // The reserved flight holds only the scheduler advisory lock during
      // dispatch. Event writes have a shorter transaction on the other pool,
      // so parent row locks are released before unrelated external sends.
      reconcile: async () => {
        const result = await reconcileEvents({
          events: pgEventStore(dispatchClient),
          writeTransaction: reconcileWriteTransaction(dispatchClient),
          queue: trackingQueue(env.SYNC_EVENT_QUEUE, pgQueueLedger(dispatchClient)),
          lock: pgUniqueLock(dispatchClient),
        });
        const failed = (result as { failed?: unknown }).failed;
        if (typeof failed === "number" && failed > 0) reconcilePartialFailures = failed;
        return result;
      },
      prune: async (db) => {
        // Report the cap and any table failures without paging inside the
        // flight; the single page fires below, after the transaction commits.
        // Sequential drains settle every table (including the per-statement
        // lock sweep on the dispatch pool) before the flight commits, so pool
        // cleanup in finally never closes a client under an in-flight sweep.
        await pruneModelTables(
          {
            ...pgPruneStores(db),
            // The lock sweep deletes the exact rows acquire targets, so it
            // must not sit inside the flight transaction: an uncommitted sweep
            // DELETE holds row locks until the whole nine-table pass commits,
            // and a concurrent acquire (INSERT .. ON CONFLICT) blocks on the
            // deleting transaction instead of superseding or inserting. Like
            // reconcile, run it on the separate dispatch pool: each DELETE
            // gets a short transaction for local timeouts, never a transaction
            // spanning the whole drain. The flight still holds the advisory
            // lock while each batch commits and releases its row locks.
            jobUniqueLocks: pgPruneStores(dispatchClient).jobUniqueLocks,
          },
          undefined,
          {
            reportCap: (capped) => {
              pruneCapped = capped;
            },
            reportFailures: (failures) => {
              pruneFailures = [...failures];
            },
          },
        );
      },
    });
    if (pruneFailures.length > 0) {
      // Partial failure with healthy tables committed: resolve the handler
      // (like the post-commit cap precedent) and page exactly once with the
      // canonical-first failure's class only. The failure page beats the cap
      // page when both land in one pass; a real error is never muted by it.
      try {
        alertScheduledFailing("model:prune", pruneFailures[0]!.error);
      } catch {
        // A throwing alert sink must not fail a committed pass.
      }
    } else if (pruneCapped) {
      try {
        alertScheduledFailing("model:prune", new PruneBatchCapError());
      } catch {
        // A throwing alert sink must not fail a committed pass.
      }
    }
    if (reconcilePartialFailures > 0) {
      // One class-only page per resolved partial pass; the pass still
      // resolves (isolated failures are never rethrown). Healthy, skipped
      // and lock-skipped passes keep failed at 0 and stay silent, and the
      // all-failed throw path never reaches here so it keeps exactly its one
      // real-class page from the catch below.
      try {
        alertScheduledFailing("events:reconcile", new ReconcilePartialFailureError());
      } catch {
        // A throwing alert sink must not fail a committed pass.
      }
    }
  } catch (err) {
    // Direct paging signal for a failed scheduled run: one redacted line per
    // failed invocation, no source-side mute. The handler still rejects with
    // the original error, and pool cleanup in finally still runs, even when
    // writing the signal itself throws.
    const job = SCHEDULED_JOB_FOR_CRON[controller.cron];
    if (job !== undefined) {
      try {
        alertScheduledFailing(job, err);
      } catch {
        // A throwing alert sink must not replace the original rejection.
      }
    }
    throw err;
  } finally {
    // Close only what was acquired, exactly once each. Cleanup failures are
    // swallowed so they never replace the original rejection.
    if (dispatchSql !== undefined) {
      await dispatchSql.end({ timeout: 1 }).catch(() => {});
    }
    if (sql !== undefined) {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  }
}
