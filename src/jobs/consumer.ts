import { alertQueueFailing } from "../alerts";
import { AlertProbeError } from "../alert-probe-error";
import { safeRequestId } from "../request-log";
import { CALL_INTERNAL_ACTION, SYNC_EVENT, backoffFor } from "./constants";
import { handleCallInternalAction } from "./call-internal-action";
import { toQueueMessage } from "./envelope";
import { handleSettingsSet } from "./settings-set";
import { queueExceptionClass, sanitizeQueueScope } from "./queue-error";
import { SYNC_RETRY_PERSISTENCE_REASON, SyncRetryPersistenceError } from "./types";
import { projectSyncRetryDiagnostic, type SyncRetryDiagnostic } from "./sync-retry-diagnostic";
import { handleSyncEvent, uniqueKey, type Outcome } from "./sync-event";
import type {
  BotClient,
  EventStore,
  QueueLedger,
  QueueMessage,
  SettingsWriter,
  UniqueLock,
} from "./types";

const LEDGER_TIMEOUT_MS = 2000;
// The unique-lock cleanup shares the ledger's posture: it must never hold the
// batch open. A rejecting or hung `release` previously propagated out of
// consume() and skipped every later ack (TOG-9895 review: firstAck=0,
// secondAck=0, whole batch lost).
const LOCK_TIMEOUT_MS = 2000;

type Msg = {
  body: unknown;
  attempts: number;
  ack(): void;
  retry(o?: { delaySeconds?: number }): void;
};

// Distinct alert reason when settlement-only redelivery outlives the app
// carrier budget: the store still has not committed the settlement, so this
// is not the terminal failure — the attempt stays pending, unstamped and
// unacked, for operator recovery. Static class-only string, never provider
// text; the delivery count rides in the alert's attempts field.
const TERMINAL_SETTLEMENT_UNAVAILABLE =
  "terminal settlement unavailable; intent retained, failSync uncommitted";

// Legacy identity of each job, for the queue.failing alert line (ports Queue::failing fields).
const JOBS = {
  "alert-probe": { queue: "two-internal-action", job: "AlertProbe", tries: 1 },
  "sync-event": { queue: "two-sync-event", job: "SyncEventToDiscord", tries: SYNC_EVENT.tries },
  announcement: {
    queue: "two-internal-action",
    job: "CallInternalAction",
    tries: CALL_INTERNAL_ACTION.tries,
  },
  "role-assign": {
    queue: "two-internal-action",
    job: "CallInternalAction",
    tries: CALL_INTERNAL_ACTION.tries,
  },
  // Dashboard settings writes ride the same internal-action queue, budget,
  // and alert identity as the other bot verbs; delivery is a settings-only
  // handler, never the role/announcement one.
  "settings-set": {
    queue: "two-internal-action",
    job: "CallInternalAction",
    tries: CALL_INTERNAL_ACTION.tries,
  },
} as const;

function alertFailing(
  kind: QueueMessage["kind"],
  attempts: number,
  exception: string,
  ids: { probeId?: string; requestId?: string },
  syncRetry?: SyncRetryDiagnostic,
) {
  const j = JOBS[kind];
  alertQueueFailing({
    connection: "cloudflare-queues",
    queue: j.queue,
    job: j.job,
    attempts,
    exception,
    probeId: ids.probeId,
    requestId: ids.requestId,
    syncRetry,
  });
}

/** Queue consumer for both queues. Terminal outcomes ack (max_retries is only a backstop). */
export async function consume(
  batch: { messages: readonly Msg[] },
  deps: {
    bot: BotClient;
    events: EventStore;
    lock: UniqueLock;
    ledger: QueueLedger;
    now?: () => Date;
    needsSync?: EventStore["needsSync"];
    dispatchPending?: (eventKey: string, signal: AbortSignal) => Promise<unknown>;
    probeEnabled?: boolean;
    // Optional so carriers from before the settings slice keep their shape;
    // production always passes it. A settings-set carrier without a writer
    // fails terminally below, never silently and never to the wrong handler.
    settings?: SettingsWriter;
  },
): Promise<void> {
  for (const m of batch.messages) {
    const body = toQueueMessage(m.body);
    if (!body) {
      // Bad carriers cannot recover on retry. Do not trust their ledger/lock
      // identifiers or log their payload; discard only this message.
      console.warn("queue malformed message discarded");
      m.ack();
      continue;
    }
    const requestId = safeRequestId(body.requestId);
    const jobId = typeof body.jobId === "string" ? body.jobId : null;
    const key = body.kind === "sync-event" ? uniqueKey(body.eventKey) : null;
    // Ledger transitions are best-effort: a stale ledger row is a visible backlog
    // on /up, but stalling job processing on the same Postgres outage that already
    // turned the probe `unknown` buys nothing. Never let them block ack/retry.
    // Class-only: ledger failures (SQL, transport errors) can carry bound
    // values or secrets in their messages.
    const ledgerWarn = (what: string) => (e: unknown) =>
      console.warn(`queue ledger ${what} failed`, { exception: queueExceptionClass(e) });
    // Bounded too: a hung ledger must not stall the batch either.
    const bounded = (what: string, op: Promise<unknown>) => {
      let t: ReturnType<typeof setTimeout>;
      const timeout = new Promise<void>((r) => {
        t = setTimeout(() => {
          ledgerWarn(what)(new Error("timed out"));
          r();
        }, LEDGER_TIMEOUT_MS);
      });
      return Promise.race([op.catch(ledgerWarn(what)), timeout]).finally(() => clearTimeout(t));
    };
    // Lock cleanup is best-effort like the ledger: warn and continue on a
    // rejecting or hung release so the terminal ack still lands and the rest
    // of the batch still runs. A stuck lock row self-heals via its TTL
    // (pgUniqueLock expires rows); the message must not be held hostage.
    const releaseLock = (key: string) => {
      // In-flight legacy messages have no ownership proof. Never infer it from
      // the event/job/idempotency key; let their original row expire instead.
      if (body.kind !== "sync-event" || !body.leaseToken) return Promise.resolve();
      let t: ReturnType<typeof setTimeout>;
      const timeout = new Promise<void>((r) => {
        t = setTimeout(() => {
          // Single-line sanitized scope: a hostile event key cannot split the log line.
          console.warn("queue lock release timed out", { scope: sanitizeQueueScope(key) });
          r();
        }, LOCK_TIMEOUT_MS);
      });
      return Promise.race([
        // Class-only: lock errors can carry SQL or connection secrets.
        deps.lock.release(key, body.leaseToken).catch((e: unknown) =>
          console.warn("queue lock release failed", {
            scope: sanitizeQueueScope(key),
            exception: queueExceptionClass(e),
          }),
        ),
        timeout,
      ]).finally(() => clearTimeout(t));
    };
    // Bounded settlement without a disposition: reports whether failSync
    // committed and leaves released/retry policy to the caller. The fresh
    // definitive path retries undelayed; settlement-only redelivery retries
    // with the carried backoff delay.
    const settleAttempt = async () => {
      if (body.kind !== "sync-event") return true;
      try {
        // Settlement is correctness-critical but must never hold the serial
        // batch open: race the same ledger bound as every sibling wait. On
        // expiry the existing catch path retries without ack; a late
        // settlement landing after the race is abandoned and changes nothing.
        // This race only stops the wait: pgEventStore.failSync cancels the
        // UPDATE server-side at the same bound (FAIL_SYNC_DB_TIMEOUT_MS), so
        // a wedged statement also frees the max:1 handler connection and the
        // next message's prepareSync still runs.
        let t: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          t = setTimeout(() => reject(new Error("timed out")), LEDGER_TIMEOUT_MS);
        });
        await Promise.race([deps.events.failSync(body.idempotencyKey), timeout]).finally(() =>
          clearTimeout(t),
        );
        return true;
      } catch (e) {
        // Snapshot settlement is correctness-critical, unlike the depth ledger.
        // Never ack a terminal message while it still blocks future revisions.
        // Class-only: settlement errors can carry SQL or connection secrets.
        console.error("sync attempt settlement failed", { exception: queueExceptionClass(e) });
        return false;
      }
    };
    const failAttempt = async () => {
      if (await settleAttempt()) return true;
      if (jobId) await bounded("released", deps.ledger.released(jobId, deps.now?.() ?? new Date()));
      m.retry();
      return false;
    };
    // Terminal-intent noting is correctness-critical like settlement: a
    // swallowed note re-strands the row (a healed redelivery waits on the
    // nulled claim forever), so a rejecting race gates the settlement path
    // instead of the best-effort bounded helper. Stores that predate the
    // marker skip noting and settle exactly as before.
    const noteTerminalIntent = async (idempotencyKey: string, reason: string) => {
      const noteOp = deps.events.noteTerminalIntent;
      if (typeof noteOp !== "function") return true;
      try {
        let t: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          t = setTimeout(() => reject(new Error("timed out")), LEDGER_TIMEOUT_MS);
        });
        await Promise.race([noteOp(idempotencyKey, reason), timeout]).finally(() =>
          clearTimeout(t),
        );
        return true;
      } catch (e) {
        console.error("sync terminal intent failed", { exception: queueExceptionClass(e) });
        return false;
      }
    };
    // Best-effort claim reopen after a failed intent note: a due deadline
    // lets a healed redelivery re-run the bot flow, re-derive the verdict
    // and re-note, instead of waiting on the nulled claim until the carrier
    // exhausts. Never holds the batch: bounded like every sibling wait.
    const reopenTerminalClaim = async (eventKey: string) => {
      let t: ReturnType<typeof setTimeout>;
      const timeout = new Promise<void>((r) => {
        t = setTimeout(() => {
          // Sanitized unique-key scope, same value as the lock lines for this
          // event, so the reopen timeout correlates with the rest of the batch.
          console.warn("sync terminal claim reopen timed out", {
            scope: sanitizeQueueScope(uniqueKey(eventKey)),
          });
          r();
        }, LEDGER_TIMEOUT_MS);
      });
      await Promise.race([
        (async () => {
          try {
            const pending = await deps.events.pendingSync(eventKey);
            if (!pending) return;
            await deps.events.deferSync(pending, deps.now?.() ?? new Date());
          } catch (e) {
            // Class-only: store errors can carry SQL or connection secrets.
            console.warn("sync terminal claim reopen failed", {
              exception: queueExceptionClass(e),
            });
          }
        })(),
        timeout,
      ]).finally(() => clearTimeout(t));
    };
    if (jobId) await bounded("reserved", deps.ledger.reserved(jobId));

    // Delivery-local only: never infer a previous carrier's cause from a waiting claim.
    let syncRetry: SyncRetryDiagnostic | undefined;
    const onRetryDiagnostic = (receipt: SyncRetryDiagnostic) => {
      syncRetry = receipt;
      console.warn("sync retry classified", projectSyncRetryDiagnostic(receipt));
    };
    let outcome: Outcome;
    try {
      if (body.kind === "alert-probe") {
        // Poison only the synthetic job, only when the runtime's QA gate is on.
        // No ledger fixture, bot request, event mutation or uniqueness lock.
        if (deps.probeEnabled) throw new AlertProbeError(body.probeId);
        outcome = { done: true }; // A delayed staging probe cannot page in production.
      } else if (body.kind === "settings-set") {
        // A settings carrier without a writer is a misconfigured worker, not
        // a retriable wait: fail it terminally so it pages instead of
        // redelivering forever or falling through to the wrong handler.
        outcome = deps.settings
          ? await handleSettingsSet(body, m.attempts, deps.settings)
          : { failed: "settings writer unconfigured" };
      } else {
        outcome =
          body.kind === "sync-event"
            ? await handleSyncEvent(body, m.attempts, {
                bot: deps.bot,
                events: deps.events,
                now: deps.now,
                onRetryDiagnostic,
              })
            : await handleCallInternalAction(body, m.attempts, deps.bot);
      }
    } catch (e) {
      if (body.kind === "sync-event" && e instanceof SyncRetryPersistenceError) {
        // Carry the known wait on this delivery, but only a committed result can
        // reopen the durable claim. Recovery must not substitute a short lease.
        console.error("sync retry result persistence failed", SYNC_RETRY_PERSISTENCE_REASON);
        // A due carried wait (now/past) must never reach the retry
        // transport as `delaySeconds: 0` — the transport requires a positive
        // integer. Take the configured sync-event backoff for this carrier
        // attempt instead; a due deadline is a delay-shape fix, not a failure
        // reclassification (exhausted and null-deadline carriers stay terminal).
        // Positive waits pass through ceiled.
        const nextAttemptAt = e.nextAttemptAt;
        if (nextAttemptAt === null || m.attempts >= SYNC_EVENT.tries) {
          outcome = { failed: SYNC_RETRY_PERSISTENCE_REASON };
        } else {
          const carriedSeconds = Math.ceil(
            (nextAttemptAt.getTime() - (deps.now?.() ?? new Date()).getTime()) / 1000,
          );
          outcome = {
            retryInSeconds:
              carriedSeconds <= 0
                ? backoffFor(SYNC_EVENT.backoffSeconds, m.attempts)
                : carriedSeconds,
          };
        }
      } else {
        // Unexpected (not a BotTransport/BotTerminal error, not a refusal): a
        // redeliverable throw goes back on the queue with the same message (same
        // idempotency key); an exhausted throw is terminal, like a failed outcome.
        // Class-only: thrown messages can carry tokens, SQL or personal data.
        console.error("job threw", body.kind, { exception: queueExceptionClass(e) });
        // Laravel only fires Queue::failing once the job is out of tries; a redeliverable throw is not a failure yet.
        if (m.attempts >= JOBS[body.kind].tries) {
          alertFailing(
            body.kind,
            m.attempts,
            queueExceptionClass(e),
            { probeId: e instanceof AlertProbeError ? e.probeId : undefined, requestId },
            syncRetry,
          );
          // Out of tries: a terminal failure, not a phantom pending row — and not
          // a retry either. The job already spent its tries (the transport's
          // max_retries is only a backstop above this cap), so ack it and free
          // the sync lock instead of requeueing a message the ledger just buried
          // (which would run again with no live depth accounting and stack up
          // duplicate failure rows).
          if (jobId)
            await bounded(
              "failed",
              deps.ledger.failed(jobId, body.kind, key, queueExceptionClass(e)),
            );
          if (body.kind === "sync-event") await releaseLock(uniqueKey(body.eventKey));
          m.ack();
        } else {
          if (jobId)
            await bounded("released", deps.ledger.released(jobId, deps.now?.() ?? new Date()));
          m.retry();
        }
        continue;
      }
    }
    if ("retryInSeconds" in outcome) {
      if (jobId)
        await bounded(
          "released",
          deps.ledger.released(
            jobId,
            new Date((deps.now?.() ?? new Date()).getTime() + outcome.retryInSeconds * 1000),
          ),
        );
      m.retry({ delaySeconds: outcome.retryInSeconds });
      continue;
    }
    if ("failed" in outcome) {
      if (body.kind === "sync-event" && outcome.definitive) {
        if (typeof outcome.intentRedeliveryBackoffSeconds === "number") {
          // Settlement-only redelivery: intent is already recorded, so re-run
          // the bounded settlement without the bot flow. A still-unsettled
          // store goes back on the queue with the carried backoff delay — the
          // live row keeps its depth accounting until the store heals. Never
          // fail, alert, or ack before failSync commits.
          if (!(await settleAttempt())) {
            // Past the app carrier budget the silent loop would run until the
            // transport backstop deletes the carrier, leaving the pending row
            // with no signal. Raise one distinct alert per delivery instead —
            // still no failed stamp and no ack before settlement commits.
            if (m.attempts > SYNC_EVENT.tries) {
              console.error("job failed", body.kind, TERMINAL_SETTLEMENT_UNAVAILABLE);
              alertFailing(
                body.kind,
                m.attempts,
                TERMINAL_SETTLEMENT_UNAVAILABLE,
                { requestId },
                syncRetry,
              );
            }
            const availableAt = new Date(
              (deps.now?.() ?? new Date()).getTime() +
                outcome.intentRedeliveryBackoffSeconds * 1000,
            );
            if (jobId) await bounded("released", deps.ledger.released(jobId, availableAt));
            m.retry({ delaySeconds: outcome.intentRedeliveryBackoffSeconds });
            continue;
          }
        } else {
          // Fresh definitive refusal: record terminal intent first (idempotent,
          // first-writer-wins), then run the existing settlement race unchanged.
          // A failed note still settles — but without intent a healed
          // redelivery would wait on the nulled claim forever, so reopen the
          // claim to a due deadline first and let redelivery re-derive the
          // verdict and re-note if this settlement also wedges.
          const noted = await noteTerminalIntent(body.idempotencyKey, outcome.failed);
          if (!noted) await reopenTerminalClaim(body.eventKey);
          if (!(await failAttempt())) continue;
        }
      }
      console.error("job failed", body.kind, outcome.failed);
      alertFailing(body.kind, m.attempts, outcome.failed, { requestId }, syncRetry);
      if (jobId) await bounded("failed", deps.ledger.failed(jobId, body.kind, key, outcome.failed));
    } else if (jobId) {
      await bounded("dequeued", deps.ledger.dequeued(jobId));
    }
    if (body.kind === "sync-event") {
      await releaseLock(uniqueKey(body.eventKey));
      if ("done" in outcome && deps.dispatchPending) {
        // Release before checking: a racing after-commit producer either owns
        // the successor lock or this dispatch does. A rejected send still
        // leaves the dirty revision for reconciliation.
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            console.warn("sync successor dispatch timed out; reconcile will retry");
            resolve();
          }, LEDGER_TIMEOUT_MS);
        });
        const successor = (async () => {
          if (await (deps.needsSync?.(body.eventKey) ?? deps.events.needsSync(body.eventKey))) {
            controller.signal.throwIfAborted();
            await deps.dispatchPending!(body.eventKey, controller.signal);
          }
        })().catch((e: unknown) => {
          // Class-only: dispatch errors come from the same Postgres calls as
          // settlement errors and can carry SQL or connection secrets.
          console.warn("sync successor dispatch failed; reconcile will retry", {
            exception: queueExceptionClass(e),
          });
        });
        await Promise.race([successor, timeout]).finally(() => clearTimeout(timer));
      }
    }
    m.ack();
  }
}
