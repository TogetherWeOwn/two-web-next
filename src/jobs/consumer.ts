import { alertQueueFailing } from "../alerts";
import { CALL_INTERNAL_ACTION, SYNC_EVENT } from "./constants";
import { handleCallInternalAction } from "./call-internal-action";
import { isQueueMessage } from "./envelope";
import { SyncRetryPersistenceError } from "./types";
import { handleSyncEvent, uniqueKey, type Outcome } from "./sync-event";
import type { BotClient, EventStore, QueueLedger, QueueMessage, UniqueLock } from "./types";

const LEDGER_TIMEOUT_MS = 2000;
// The unique-lock cleanup shares the ledger's posture: it must never hold the
// batch open. A rejecting or hung `release` previously propagated out of
// consume() and skipped every later ack (TOG-9895 review: firstAck=0,
// secondAck=0, whole batch lost).
const LOCK_TIMEOUT_MS = 2000;

type Msg = { body: unknown; attempts: number; ack(): void; retry(o?: { delaySeconds?: number }): void };

// Legacy identity of each job, for the queue.failing alert line (ports Queue::failing fields).
const JOBS = {
  "sync-event": { queue: "two-sync-event", job: "SyncEventToDiscord", tries: SYNC_EVENT.tries },
  announcement: { queue: "two-internal-action", job: "CallInternalAction", tries: CALL_INTERNAL_ACTION.tries },
  "role-assign": { queue: "two-internal-action", job: "CallInternalAction", tries: CALL_INTERNAL_ACTION.tries },
} as const;

function alertFailing(kind: QueueMessage["kind"], attempts: number, exception: string) {
  const j = JOBS[kind];
  alertQueueFailing({ connection: "cloudflare-queues", queue: j.queue, job: j.job, attempts, exception });
}

/** Queue consumer for both queues. Terminal outcomes ack (max_retries is only a backstop). */
export async function consume(
  batch: { messages: readonly Msg[] },
  deps: { bot: BotClient; events: EventStore; lock: UniqueLock; ledger: QueueLedger;
    now?: () => Date;
    needsSync?: EventStore["needsSync"];
    dispatchPending?: (eventKey: string, signal: AbortSignal) => Promise<unknown> },
): Promise<void> {
  for (const m of batch.messages) {
    const body = m.body;
    if (!isQueueMessage(body)) {
      // Bad carriers cannot recover on retry. Do not trust their ledger/lock
      // identifiers or log their payload; discard only this message.
      console.warn("queue malformed message discarded");
      m.ack();
      continue;
    }
    const jobId = typeof body.jobId === "string" ? body.jobId : null;
    const key = body.kind === "sync-event" ? uniqueKey(body.eventKey) : null;
    // Ledger transitions are best-effort: a stale ledger row is a visible backlog
    // on /up, but stalling job processing on the same Postgres outage that already
    // turned the probe `unknown` buys nothing. Never let them block ack/retry.
    const ledgerWarn = (what: string) => (e: unknown) =>
      console.warn(`queue ledger ${what} failed`, e instanceof Error ? e.message : e);
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
          console.warn("queue lock release timed out", key);
          r();
        }, LOCK_TIMEOUT_MS);
      });
      return Promise.race([
        deps.lock.release(key, body.leaseToken).catch((e: unknown) =>
          console.warn("queue lock release failed", key, e instanceof Error ? e.message : e)),
        timeout,
      ]).finally(() => clearTimeout(t));
    };
    const failAttempt = async () => {
      if (body.kind !== "sync-event") return true;
      try {
        await deps.events.failSync(body.idempotencyKey);
        return true;
      } catch (e) {
        // Snapshot settlement is correctness-critical, unlike the depth ledger.
        // Never ack a terminal message while it still blocks future revisions.
        console.error("sync attempt settlement failed", e instanceof Error ? e.message : e);
        m.retry();
        return false;
      }
    };
    if (jobId) await bounded("reserved", deps.ledger.reserved(jobId));

    let outcome: Outcome;
    try {
      outcome =
        body.kind === "sync-event"
          ? await handleSyncEvent(body, m.attempts, deps)
          : await handleCallInternalAction(body, m.attempts, deps.bot);
    } catch (e) {
      if (body.kind === "sync-event" && e instanceof SyncRetryPersistenceError) {
        // Carry the known wait on this delivery, but only a committed result can
        // reopen the durable claim. Recovery must not substitute a short lease.
        console.error("sync retry result persistence failed", e.message);
        outcome = e.nextAttemptAt === null || m.attempts >= SYNC_EVENT.tries
          ? { failed: e.message }
          : { retryInSeconds: Math.max(0, Math.ceil((e.nextAttemptAt.getTime()
            - (deps.now?.() ?? new Date()).getTime()) / 1000)) };
      } else {
        // Unexpected (not a BotTransport/BotTerminal error, not a refusal): a
        // redeliverable throw goes back on the queue with the same message (same
        // idempotency key); an exhausted throw is terminal, like a failed outcome.
        console.error("job threw", body.kind, e instanceof Error ? e.message : e);
        // Laravel only fires Queue::failing once the job is out of tries; a redeliverable throw is not a failure yet.
        if (m.attempts >= JOBS[body.kind].tries) {
          // An unexpected/exhausted carrier says nothing definitive about the
          // remote request. Keep any pending snapshot; only retire this ledger.
          alertFailing(body.kind, m.attempts, e instanceof Error ? e.constructor.name : typeof e);
          // Out of tries: a terminal failure, not a phantom pending row — and not
          // a retry either. The job already spent its tries (the transport's
          // max_retries is only a backstop above this cap), so ack it and free
          // the sync lock instead of requeueing a message the ledger just buried
          // (which would run again with no live depth accounting and stack up
          // duplicate failure rows).
          if (jobId) await bounded("failed", deps.ledger.failed(jobId, body.kind, key, e instanceof Error ? e.constructor.name : "threw"));
          if (body.kind === "sync-event") await releaseLock(uniqueKey(body.eventKey));
          m.ack();
        } else {
          if (jobId) await bounded("released", deps.ledger.released(jobId, new Date()));
          m.retry();
        }
        continue;
      }
    }
    if ("retryInSeconds" in outcome) {
      if (jobId)
        await bounded("released", deps.ledger.released(jobId, new Date(Date.now() + outcome.retryInSeconds * 1000)));
      m.retry({ delaySeconds: outcome.retryInSeconds });
      continue;
    }
    if ("failed" in outcome) {
      if (outcome.definitive && !(await failAttempt())) continue;
      console.error("job failed", body.kind, outcome.failed);
      alertFailing(body.kind, m.attempts, outcome.failed);
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
          console.warn("sync successor dispatch failed; reconcile will retry", e instanceof Error ? e.message : e);
        });
        await Promise.race([successor, timeout]).finally(() => clearTimeout(timer));
      }
    }
    m.ack();
  }
}
