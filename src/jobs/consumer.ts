import { handleCallInternalAction } from "./call-internal-action";
import { handleSyncEvent, uniqueKey, type Outcome } from "./sync-event";
import type { BotClient, EventStore, QueueLedger, QueueMessage, UniqueLock } from "./types";

type Msg = { body: unknown; attempts: number; ack(): void; retry(o?: { delaySeconds?: number }): void };

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
    if (jobId) await deps.ledger.reserved(jobId).catch(ledgerWarn("reserved"));

    let outcome: Outcome;
    try {
      outcome =
        body.kind === "sync-event"
          ? await handleSyncEvent(body, m.attempts, deps)
          : await handleCallInternalAction(body, m.attempts, deps.bot);
    } catch (e) {
      // Unexpected: let the platform redeliver with the same message (same idempotency key).
      if (jobId) await deps.ledger.released(jobId, new Date()).catch(ledgerWarn("released"));
      console.error("job threw; will redeliver", body.kind, e instanceof Error ? e.message : e);
      m.retry();
      continue;
    }
    if ("retryInSeconds" in outcome) {
      if (jobId)
        await deps.ledger
          .released(jobId, new Date(Date.now() + outcome.retryInSeconds * 1000))
          .catch(ledgerWarn("released"));
      m.retry({ delaySeconds: outcome.retryInSeconds });
      continue;
    }
    if ("failed" in outcome) {
      console.error("job failed", body.kind, outcome.failed);
      if (jobId) await deps.ledger.failed(jobId, body.kind, key, outcome.failed).catch(ledgerWarn("failed"));
    } else if (jobId) {
      await deps.ledger.dequeued(jobId).catch(ledgerWarn("dequeued"));
    }
    if (body.kind === "sync-event") await deps.lock.release(uniqueKey(body.eventKey));
    m.ack();
  }
}
