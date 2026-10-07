import { SYNC_EVENT, backoffFor } from "./constants";
import { botRefusalReason, sanitizeQueueScope, terminalFailureReason } from "./queue-error";
import { BotTerminalError, BotTransportError, SyncRetryPersistenceError } from "./types";
import type { BotClient, BotFailure, EventStore, UniqueLock } from "./types";
import { safeRequestId } from "../request-log";
import { syncRetryDiagnostic, type SyncRetryDiagnostic } from "./sync-retry-diagnostic";

export type Outcome =
  | { done: true }
  | { retryInSeconds: number }
  | { failed: string; definitive?: true };

export const uniqueKey = (eventKey: string) => `sync-event:${eventKey}`;

const LOCK_TIMEOUT_MS = 2000;

/** Producer: idempotency key minted once, here (the constructor in Laravel), and carried on every retry. */
export async function dispatchSyncEvent(
  queue: { send(body: unknown, opts?: { delaySeconds?: number }): Promise<unknown> },
  lock: UniqueLock,
  eventKey: string,
  // Build-time key (the constructor in Laravel): every retry carries this same key.
  idempotencyKey: string = crypto.randomUUID(),
  signal?: AbortSignal,
  // Originating HTTP request for queue.failing correlation; optional for
  // scheduled/reconcile/legacy dispatches. Never a job or idempotency key.
  requestId?: string,
): Promise<boolean> {
  signal?.throwIfAborted();
  // ShouldBeUnique: a still-queued write-back absorbs this dispatch.
  const key = uniqueKey(eventKey);
  const leaseToken = await lock.acquire(key, SYNC_EVENT.uniqueForSeconds);
  if (!leaseToken) return false;
  try {
    signal?.throwIfAborted();
    await queue.send(
      // Idempotency stays build-time; correlation rides alongside, never as the key.
      {
        kind: "sync-event",
        eventKey,
        idempotencyKey,
        leaseToken,
        requestId: safeRequestId(requestId),
      },
      { delaySeconds: SYNC_EVENT.debounceSeconds },
    );
  } catch (err) {
    // Failed send: compensate only this acquisition, never a newer holder.
    // Like terminal cleanup, a wedged DELETE must not hold dispatch hostage.
    // TTL recovers a stuck lease; a late DELETE remains fenced by this token.
    let t: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((resolve) => {
      t = setTimeout(resolve, LOCK_TIMEOUT_MS);
    });
    await Promise.race([
      Promise.resolve()
        .then(() => lock.release(key, leaseToken))
        .catch(() => {}),
      timeout,
    ]).finally(() => clearTimeout(t));
    throw err;
  }
  return true;
}

/** Carrier tries and request tries are separate: retiring a carrier cannot resolve an ambiguous request. */
export async function handleSyncEvent(
  msg: { eventKey: string; idempotencyKey: string },
  attempts: number,
  deps: {
    bot: BotClient;
    events: EventStore;
    now?: () => Date;
    onRetryDiagnostic?: (receipt: SyncRetryDiagnostic) => void | Promise<void>;
  },
): Promise<Outcome> {
  const now = deps.now ?? (() => new Date());
  const waiting = (seconds: number = SYNC_EVENT.debounceSeconds): Outcome =>
    attempts >= SYNC_EVENT.tries
      ? { failed: "waiting carrier exhausted; request remains recoverable" }
      : { retryInSeconds: seconds };
  // First send snapshots the debounced row; all recovery uses that exact request.
  const prepared = await deps.events.prepareSync(msg.eventKey, msg.idempotencyKey, now());
  if (!prepared) return { done: true };
  if ("waiting" in prepared) return waiting();
  if (prepared.state !== "pending") return { done: true };
  if (prepared.requestAttempts >= SYNC_EVENT.tries) {
    return { failed: "request retry budget exhausted; unresolved identity retained" };
  }
  // Claims stay closed until their result commits. A lost response/deadline
  // cannot become eligible again merely because a short lease expired.
  if (!prepared.nextAttemptAt) return waiting(SYNC_EVENT.uniqueForSeconds);
  const remaining = Math.ceil((prepared.nextAttemptAt.getTime() - now().getTime()) / 1000);
  if (remaining > 0) return waiting(remaining);
  // A durable closed claim fences concurrent carriers until its result commits.
  const claimedAt = now();
  const attempt = await deps.events.claimSync(prepared, claimedAt);
  if (!attempt) return waiting();
  // A never-attempted snapshot may have become obsolete since preparation.
  // Its atomic first claim retires it without remote I/O or revision acknowledgement.
  if (attempt.state !== "pending") return { done: true };
  const reportRetry = (retryClass: "BotFailure" | "BotTransportError", answer?: BotFailure) => {
    // Observability must not turn a known refusal into transport ambiguity or change its wait.
    try {
      const observe = deps.onRetryDiagnostic;
      if (!observe) return;
      let code: unknown;
      try {
        code = answer?.code;
      } catch {}
      Promise.resolve(
        observe(syncRetryDiagnostic(retryClass, code, attempts, attempt, claimedAt)),
      ).catch(() => {});
    } catch {}
  };
  let retryDeadline: Date | null | undefined;
  const retry = async (seconds: number): Promise<Outcome> => {
    const exhausted = attempt.requestAttempts >= SYNC_EVENT.tries;
    retryDeadline = exhausted ? null : new Date(now().getTime() + seconds * 1000);
    await deps.events.deferSync(attempt, retryDeadline);
    return exhausted || attempts >= SYNC_EVENT.tries
      ? { failed: "carrier exhausted; unresolved identity retained" }
      : { retryInSeconds: seconds };
  };
  const backoff = () =>
    backoffFor(SYNC_EVENT.backoffSeconds, Math.max(attempts, attempt.requestAttempts));
  try {
    const answer =
      attempt.action === "event.cancel"
        ? await deps.bot.cancelEvent(attempt.payload, msg.idempotencyKey)
        : await deps.bot.upsertEvent(attempt.payload, msg.idempotencyKey);
    if (!answer.ok) {
      if (!answer.retryable)
        return {
          definitive: true,
          failed: botRefusalReason(
            `${attempt.action} for ${sanitizeQueueScope(msg.eventKey)}`,
            answer.code,
          ),
        };
      // Record the refusal before persistence can throw and obscure its cause.
      reportRetry("BotFailure", answer);
      return await retry(answer.retryAfterSeconds ?? backoff());
    }
    await deps.events.completeSync(attempt, answer.discordEventId);
    return { done: true };
  } catch (e) {
    if (retryDeadline !== undefined) {
      // A known refusal's persistence failure is not transport ambiguity. Retry
      // the same absolute deadline (including exhausted null), never shorter backoff.
      try {
        await deps.events.deferSync(attempt, retryDeadline);
      } catch (persistenceError) {
        throw new SyncRetryPersistenceError(retryDeadline, persistenceError);
      }
      throw e;
    }
    if (e instanceof BotTerminalError) return { failed: terminalFailureReason(), definitive: true };
    // Transport loss and local completion failure are both ambiguous. Never
    // replace their identity even at the carrier/request cap.
    if (e instanceof BotTransportError) {
      reportRetry("BotTransportError");
      return retry(backoff());
    }
    await deps.events.deferSync(
      attempt,
      attempt.requestAttempts >= SYNC_EVENT.tries
        ? null
        : new Date(now().getTime() + backoff() * 1000),
    );
    throw e;
  }
}
