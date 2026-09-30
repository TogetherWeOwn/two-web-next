import { alertQueueFailing } from "../alerts";
import { CALL_INTERNAL_ACTION, SYNC_EVENT } from "./constants";
import { handleCallInternalAction } from "./call-internal-action";
import { handleSyncEvent, uniqueKey, type Outcome } from "./sync-event";
import type { BotClient, EventStore, QueueLedger, QueueMessage, UniqueLock } from "./types";

const LEDGER_TIMEOUT_MS = 2000;

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
  deps: { bot: BotClient; events: EventStore; lock: UniqueLock; ledger: QueueLedger },
): Promise<void> {
  for (const m of batch.messages) {
    const body = m.body as QueueMessage;
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
    if (jobId) await bounded("reserved", deps.ledger.reserved(jobId));

    let outcome: Outcome;
    try {
      outcome =
        body.kind === "sync-event"
          ? await handleSyncEvent(body, m.attempts, deps)
          : await handleCallInternalAction(body, m.attempts, deps.bot);
    } catch (e) {
      // Unexpected: let the platform redeliver with the same message (same idempotency key).
      console.error("job threw; will redeliver", body.kind, e instanceof Error ? e.message : e);
      // Laravel only fires Queue::failing once the job is out of tries; a redeliverable throw is not a failure yet.
      if (m.attempts >= JOBS[body.kind].tries) {
        alertFailing(body.kind, m.attempts, e instanceof Error ? e.constructor.name : typeof e);
        // Out of tries: a terminal failure, not a phantom pending row.
        if (jobId) await bounded("failed", deps.ledger.failed(jobId, body.kind, key, e instanceof Error ? e.constructor.name : "threw"));
      } else if (jobId) {
        await bounded("released", deps.ledger.released(jobId, new Date()));
      }
      m.retry();
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
    if (body.kind === "sync-event") await deps.lock.release(uniqueKey(body.eventKey));
    m.ack();
  }
}
