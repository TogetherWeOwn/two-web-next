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
  // Stamp no RSVP newer than the row read; a write during the bot call must
  // remain pending, even if it committed before the response arrived.
  const mirroredAt = (deps.now ?? (() => new Date()))();
  const event = await deps.events.find(msg.eventKey);
  if (!event) return { done: true }; // deleted while queued: drop
  if (!event.mirrored || (event.status !== "published" && event.status !== "cancelled")) return { done: true };
  const action = event.status === "cancelled" ? "event.cancel" : "event.upsert";

  // Laravel release(): past $tries the job fails (MaxAttemptsExceeded).
  const retry = (seconds: number): Outcome =>
    attempts >= SYNC_EVENT.tries
      ? { failed: `gave up after ${attempts} attempts` }
      : { retryInSeconds: seconds };

  let answer;
  try {
    answer = action === "event.cancel"
      ? await deps.bot.cancelEvent({ eventKey: event.eventKey }, msg.idempotencyKey)
      : await deps.bot.upsertEvent(event.payload, msg.idempotencyKey);
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
  await deps.events.recordMirrored(msg.eventKey, answer.discordEventId, mirroredAt);
  return { done: true };
}
