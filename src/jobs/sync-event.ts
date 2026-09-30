import { SYNC_EVENT, backoffFor } from "./constants";
import { BotTerminalError, BotTransportError } from "./types";
import type { BotClient, EventStore, UniqueLock } from "./types";

export type Outcome = { done: true } | { retryInSeconds: number } | { failed: string };

export const uniqueKey = (eventKey: string) => `sync-event:${eventKey}`;

/** Producer: idempotency key minted once, here (the constructor in Laravel), and carried on every retry. */
export async function dispatchSyncEvent(
  queue: { send(body: unknown, opts?: { delaySeconds?: number }): Promise<unknown> },
  lock: UniqueLock,
  eventKey: string,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<boolean> {
  // ShouldBeUnique: a still-queued write-back absorbs this dispatch.
  if (!(await lock.acquire(uniqueKey(eventKey), SYNC_EVENT.uniqueForSeconds))) return false;
  try {
    await queue.send(
      { kind: "sync-event", eventKey, idempotencyKey },
      { delaySeconds: SYNC_EVENT.debounceSeconds },
    );
  } catch (err) {
    // No accepted message owns this lock. Allow the next edit/reconcile to retry.
    await lock.release(uniqueKey(eventKey)).catch(() => {});
    throw err;
  }
  return true;
}

/** Ports SyncEventToDiscord::handle. `attempts` is 1-based. The unique lock is freed by the caller on done/failed. */
export async function handleSyncEvent(
  msg: { eventKey: string; idempotencyKey: string },
  attempts: number,
  deps: { bot: BotClient; events: EventStore; now?: () => Date },
): Promise<Outcome> {
  // First send reads the latest debounced row. Persist that exact request before
  // contacting the bot: a lost response must retry it under the same UUID, not
  // a newer edit (which gets its own subsequent request/key).
  const attempt = await deps.events.prepareSync(msg.eventKey, msg.idempotencyKey, (deps.now ?? (() => new Date()))());
  if (!attempt) return { done: true }; // deleted/draft/past before first send
  if ("waiting" in attempt) return { retryInSeconds: SYNC_EVENT.debounceSeconds };
  if (attempt.state !== "pending") return { done: true }; // settled redelivery
  const action = attempt.action;

  // Laravel release(): past $tries the job fails (MaxAttemptsExceeded).
  const retry = (seconds: number): Outcome =>
    attempts >= SYNC_EVENT.tries
      ? { failed: `gave up after ${attempts} attempts` }
      : { retryInSeconds: seconds };

  let answer;
  try {
    answer = attempt.action === "event.cancel"
      ? await deps.bot.cancelEvent(attempt.payload, msg.idempotencyKey)
      : await deps.bot.upsertEvent(attempt.payload, msg.idempotencyKey);
  } catch (e) {
    if (e instanceof BotTransportError) return retry(backoffFor(SYNC_EVENT.backoffSeconds, attempts));
    if (e instanceof BotTerminalError) return { failed: e.message };
    throw e;
  }
  if (!answer.ok) {
    if (!answer.retryable) {
      return { failed: `The bot refused ${action} for ${msg.eventKey} with \`${answer.code}\`: ${answer.message}` };
    }
    // The bot's number beats ours: on a 429 it knows where the ceiling is.
    return retry(answer.retryAfterSeconds ?? backoffFor(SYNC_EVENT.backoffSeconds, attempts));
  }
  await deps.events.completeSync(attempt, answer.discordEventId);
  return { done: true };
}
