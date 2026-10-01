import { SYNC_EVENT, backoffFor } from "./constants";
import { BotTerminalError, BotTransportError } from "./types";
import type { BotClient, EventStore, UniqueLock } from "./types";

export type Outcome = { done: true } | { retryInSeconds: number } | { failed: string; definitive?: true };

export const uniqueKey = (eventKey: string) => `sync-event:${eventKey}`;

/** Producer: idempotency key minted once, here (the constructor in Laravel), and carried on every retry. */
export async function dispatchSyncEvent(
  queue: { send(body: unknown, opts?: { delaySeconds?: number }): Promise<unknown> },
  lock: UniqueLock,
  eventKey: string,
  idempotencyKey: string = crypto.randomUUID(),
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  // ShouldBeUnique: a still-queued write-back absorbs this dispatch.
  if (!(await lock.acquire(uniqueKey(eventKey), SYNC_EVENT.uniqueForSeconds))) return false;
  try {
    signal?.throwIfAborted();
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

/** Carrier tries and request tries are separate: retiring a carrier cannot resolve an ambiguous request. */
export async function handleSyncEvent(
  msg: { eventKey: string; idempotencyKey: string },
  attempts: number,
  deps: { bot: BotClient; events: EventStore; now?: () => Date },
): Promise<Outcome> {
  const now = deps.now ?? (() => new Date());
  const waiting = (seconds: number = SYNC_EVENT.debounceSeconds): Outcome => attempts >= SYNC_EVENT.tries
    ? { failed: "waiting carrier exhausted; request remains recoverable" }
    : { retryInSeconds: seconds };
  // First send snapshots the debounced row; all recovery uses that exact request.
  const prepared = await deps.events.prepareSync(msg.eventKey, msg.idempotencyKey, now());
  if (!prepared) return { done: true };
  if ("waiting" in prepared) return waiting();
  if (prepared.state !== "pending") return { done: true };
  if (prepared.requestAttempts >= SYNC_EVENT.tries || !prepared.nextAttemptAt) {
    return { failed: "request retry budget exhausted; unresolved identity retained" };
  }
  const remaining = Math.ceil((prepared.nextAttemptAt.getTime() - now().getTime()) / 1000);
  if (remaining > 0) return waiting(remaining);
  // A durable claim fences concurrent carriers and leases an in-flight request.
  const attempt = await deps.events.claimSync(prepared, now());
  if (!attempt) return waiting();
  // A never-attempted snapshot may have become obsolete since preparation.
  // Its atomic first claim retires it without remote I/O or revision acknowledgement.
  if (attempt.state !== "pending") return { done: true };
  const retry = async (seconds: number): Promise<Outcome> => {
    const exhausted = attempt.requestAttempts >= SYNC_EVENT.tries;
    await deps.events.deferSync(attempt, exhausted ? null : new Date(now().getTime() + seconds * 1000));
    return exhausted || attempts >= SYNC_EVENT.tries
      ? { failed: "carrier exhausted; unresolved identity retained" }
      : { retryInSeconds: seconds };
  };
  const backoff = () => backoffFor(SYNC_EVENT.backoffSeconds, Math.max(attempts, attempt.requestAttempts));
  try {
    const answer = attempt.action === "event.cancel"
      ? await deps.bot.cancelEvent(attempt.payload, msg.idempotencyKey)
      : await deps.bot.upsertEvent(attempt.payload, msg.idempotencyKey);
    if (!answer.ok) {
      if (!answer.retryable) return { definitive: true,
        failed: `The bot refused ${attempt.action} for ${msg.eventKey} with \`${answer.code}\`: ${answer.message}` };
      return await retry(answer.retryAfterSeconds ?? backoff());
    }
    await deps.events.completeSync(attempt, answer.discordEventId);
    return { done: true };
  } catch (e) {
    if (e instanceof BotTerminalError) return { failed: e.message, definitive: true };
    // Transport loss and local completion failure are both ambiguous. Never
    // replace their identity even at the carrier/request cap.
    if (e instanceof BotTransportError) return retry(backoff());
    await deps.events.deferSync(attempt, attempt.requestAttempts >= SYNC_EVENT.tries
      ? null : new Date(now().getTime() + backoff() * 1000));
    throw e;
  }
}
