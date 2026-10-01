import { SYNC_EVENT, backoffFor } from "./constants";
import { BotTerminalError, BotTransportError } from "./types";
import type { BotClient, EventStore, UniqueLock } from "./types";

export type Outcome = { done: true } | { retryInSeconds: number } | { failed: string };

export const uniqueKey = (eventKey: string) => `sync-event:${eventKey}`;

const LOCK_TIMEOUT_MS = 2000;

/** Producer: idempotency key minted once, here (the constructor in Laravel), and carried on every retry. */
export async function dispatchSyncEvent(
  queue: { send(body: unknown, opts?: { delaySeconds?: number }): Promise<unknown> },
  lock: UniqueLock,
  eventKey: string,
): Promise<boolean> {
  // ShouldBeUnique: a still-queued write-back absorbs this dispatch.
  const key = uniqueKey(eventKey);
  const leaseToken = await lock.acquire(key, SYNC_EVENT.uniqueForSeconds);
  if (!leaseToken) return false;
  try {
    await queue.send(
      { kind: "sync-event", eventKey, idempotencyKey: crypto.randomUUID(), leaseToken },
      { delaySeconds: SYNC_EVENT.debounceSeconds },
    );
  } catch (err) {
    // Failed send: compensate only this acquisition, never a newer holder.
    // Like terminal cleanup, a wedged DELETE must not hold dispatch hostage.
    // TTL recovers a stuck lease; a late DELETE remains fenced by this token.
    let t: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((resolve) => { t = setTimeout(resolve, LOCK_TIMEOUT_MS); });
    await Promise.race([
      Promise.resolve().then(() => lock.release(key, leaseToken)).catch(() => {}),
      timeout,
    ]).finally(() => clearTimeout(t));
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
  const event = await deps.events.find(msg.eventKey);
  if (!event) return { done: true }; // deleted while queued: drop
  if (!event.mirrored) return { done: true }; // draft/cancelled/past: not ours to upsert

  // Laravel release(): past $tries the job fails (MaxAttemptsExceeded).
  const retry = (seconds: number): Outcome =>
    attempts >= SYNC_EVENT.tries
      ? { failed: `gave up after ${attempts} attempts` }
      : { retryInSeconds: seconds };

  let answer;
  try {
    answer = await deps.bot.upsertEvent(event.payload, msg.idempotencyKey);
  } catch (e) {
    if (e instanceof BotTransportError) return retry(backoffFor(SYNC_EVENT.backoffSeconds, attempts));
    if (e instanceof BotTerminalError) return { failed: e.message };
    throw e;
  }
  if (!answer.ok) {
    if (!answer.retryable) {
      return { failed: `The bot refused event.upsert for ${msg.eventKey} with \`${answer.code}\`: ${answer.message}` };
    }
    // The bot's number beats ours: on a 429 it knows where the ceiling is.
    return retry(answer.retryAfterSeconds ?? backoffFor(SYNC_EVENT.backoffSeconds, attempts));
  }
  await deps.events.recordMirrored(msg.eventKey, answer.discordEventId, (deps.now ?? (() => new Date()))());
  return { done: true };
}
