import { handleCallInternalAction } from "./call-internal-action";
import { handleSyncEvent, uniqueKey, type Outcome } from "./sync-event";
import type { BotClient, EventStore, QueueMessage, UniqueLock } from "./types";

type Msg = { body: unknown; attempts: number; ack(): void; retry(o?: { delaySeconds?: number }): void };

/** Queue consumer for both queues. Terminal outcomes ack (max_retries is only a backstop). */
export async function consume(
  batch: { messages: readonly Msg[] },
  deps: { bot: BotClient; events: EventStore; lock: UniqueLock },
): Promise<void> {
  for (const m of batch.messages) {
    const body = m.body as QueueMessage;
    let outcome: Outcome;
    try {
      outcome =
        body.kind === "sync-event"
          ? await handleSyncEvent(body, m.attempts, deps)
          : await handleCallInternalAction(body, m.attempts, deps.bot);
    } catch (e) {
      // Unexpected: let the platform redeliver with the same message (same idempotency key).
      console.error("job threw; will redeliver", body.kind, e instanceof Error ? e.message : e);
      m.retry();
      continue;
    }
    if ("retryInSeconds" in outcome) {
      m.retry({ delaySeconds: outcome.retryInSeconds });
      continue;
    }
    if ("failed" in outcome) console.error("job failed", body.kind, outcome.failed);
    if (body.kind === "sync-event") await deps.lock.release(uniqueKey(body.eventKey));
    m.ack();
  }
}
