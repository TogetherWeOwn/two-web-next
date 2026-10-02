import { alertQueueFailing } from "../alerts";
import { AlertProbeError } from "../alert-probe-error";
import { CALL_INTERNAL_ACTION, SYNC_EVENT } from "./constants";
import { handleCallInternalAction } from "./call-internal-action";
import { toQueueMessage } from "./envelope";
import { queueExceptionClass, sanitizeQueueScope } from "./queue-error";
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
  "alert-probe": { queue: "two-internal-action", job: "AlertProbe", tries: 1 },
  "sync-event": { queue: "two-sync-event", job: "SyncEventToDiscord", tries: SYNC_EVENT.tries },
  announcement: { queue: "two-internal-action", job: "CallInternalAction", tries: CALL_INTERNAL_ACTION.tries },
  "role-assign": { queue: "two-internal-action", job: "CallInternalAction", tries: CALL_INTERNAL_ACTION.tries },
} as const;

function alertFailing(kind: QueueMessage["kind"], attempts: number, exception: string, probeId?: string) {
  const j = JOBS[kind];
  alertQueueFailing({ connection: "cloudflare-queues", queue: j.queue, job: j.job, attempts, exception, probeId });
}

/** Queue consumer for both queues. Terminal outcomes ack (max_retries is only a backstop). */
export async function consume(
  batch: { messages: readonly Msg[] },
  deps: { bot: BotClient; events: EventStore; lock: UniqueLock; ledger: QueueLedger; probeEnabled?: boolean },
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
          console.warn("queue lock release timed out", sanitizeQueueScope(key));
          r();
        }, LOCK_TIMEOUT_MS);
      });
      return Promise.race([
        // Class-only: lock errors can carry SQL or connection secrets.
        deps.lock.release(key, body.leaseToken).catch((e: unknown) =>
          console.warn("queue lock release failed", sanitizeQueueScope(key), { exception: queueExceptionClass(e) })),
        timeout,
      ]).finally(() => clearTimeout(t));
    };
    if (jobId) await bounded("reserved", deps.ledger.reserved(jobId));

    let outcome: Outcome;
    try {
      if (body.kind === "alert-probe") {
        // Poison only the synthetic job, only when the runtime's QA gate is on.
        // No ledger fixture, bot request, event mutation or uniqueness lock.
        if (deps.probeEnabled) throw new AlertProbeError(body.probeId);
        outcome = { done: true }; // A delayed staging probe cannot page in production.
      } else {
        outcome = body.kind === "sync-event"
          ? await handleSyncEvent(body, m.attempts, deps)
          : await handleCallInternalAction(body, m.attempts, deps.bot);
      }
    } catch (e) {
      // Unexpected (not a BotTransport/BotTerminal error, not a refusal): a
      // redeliverable throw goes back on the queue with the same message (same
      // idempotency key); an exhausted throw is terminal, like a failed outcome.
      // Class-only: thrown messages can carry tokens, SQL or personal data.
      console.error("job threw", body.kind, { exception: queueExceptionClass(e) });
      // Laravel only fires Queue::failing once the job is out of tries; a redeliverable throw is not a failure yet.
      if (m.attempts >= JOBS[body.kind].tries) {
        alertFailing(body.kind, m.attempts, queueExceptionClass(e),
          e instanceof AlertProbeError ? e.probeId : undefined);
        // Out of tries: a terminal failure, not a phantom pending row — and not
        // a retry either. The job already spent its tries (the transport's
        // max_retries is only a backstop above this cap), so ack it and free
        // the sync lock instead of requeueing a message the ledger just buried
        // (which would run again with no live depth accounting and stack up
        // duplicate failure rows).
        if (jobId) await bounded("failed", deps.ledger.failed(jobId, body.kind, key, queueExceptionClass(e)));
        if (body.kind === "sync-event") await releaseLock(uniqueKey(body.eventKey));
        m.ack();
      } else {
        if (jobId) await bounded("released", deps.ledger.released(jobId, new Date()));
        m.retry();
      }
      continue;
    }
    if ("retryInSeconds" in outcome) {
      if (jobId)
        await bounded("released", deps.ledger.released(jobId, new Date(Date.now() + outcome.retryInSeconds * 1000)));
      m.retry({ delaySeconds: outcome.retryInSeconds });
      continue;
    }
    if ("failed" in outcome) {
      console.error("job failed", body.kind, outcome.failed);
      alertFailing(body.kind, m.attempts, outcome.failed);
      if (jobId) await bounded("failed", deps.ledger.failed(jobId, body.kind, key, outcome.failed));
    } else if (jobId) {
      await bounded("dequeued", deps.ledger.dequeued(jobId));
    }
    if (body.kind === "sync-event") await releaseLock(uniqueKey(body.eventKey));
    m.ack();
  }
}
