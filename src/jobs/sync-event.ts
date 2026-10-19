import { SYNC_EVENT, backoffFor } from "./constants";
import { botRefusalReason, sanitizeQueueScope, terminalFailureReason } from "./queue-error";
import { admitRetryDelay, MAX_RETRY_DELAY_SECONDS } from "./retry-delay";
import { BotTerminalError, BotTransportError, SyncRetryPersistenceError } from "./types";
import type { BotClient, BotFailure, EventStore, UniqueLock } from "./types";
import { safeRequestId } from "../request-log";
import {
  refusalRetryCode,
  syncRetryDiagnostic,
  type SyncRetryDiagnostic,
} from "./sync-retry-diagnostic";

export type Outcome =
  | { done: true }
  | { retryInSeconds: number }
  | { failed: string; definitive?: true };

export const uniqueKey = (eventKey: string) => `sync-event:${eventKey}`;

const LOCK_TIMEOUT_MS = 2000;
/**
 * Per-op bound for the producer's lock-acquire and queue-send.
 * Every neighboring op races a deadline; acquire and send were awaited bare,
 * so one hung Postgres INSERT or one hung queue transport stalled the web
 * after-commit producer (and the reconcile redispatch) with no recovery.
 * Past this deadline dispatch rejects as a transport wait — the same
 * disposition as "queue down", recovered by reconcile — and any acquired
 * lease is released. Pinned so changes are deliberate.
 */
export const PRODUCER_TIMEOUT_MS = 2000;

/**
 * Race `op` against an independent setTimeout deadline. The timer is always
 * cleared, and a late settle after the deadline wins is ignored: it can never
 * reclassify the already-disposed outcome (Promise.race stays attached to both
 * branches, so a late rejection is handled, not unhandled).
 */
export async function withProducerDeadline<T>(
  op: Promise<T>,
  ms: number = PRODUCER_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BotTransportError(`sync producer timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([op, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Producer: idempotency key minted once, here (the constructor in Laravel), and carried on every retry.
 *
 * Late settlement is best-effort: past the deadline dispatch rejects while the
 * underlying acquire/send may still be in flight. Callers that need Workers
 * lifetime for that tail (the successor path) pass `onLateSettlement` and hold
 * the received promises in their own waitUntil; callers without lifetime
 * (the web after-commit path, whose pool ends in its finally) accept that a
 * late token lingers until its TTL and a late ledger compensation stays as
 * visible phantom backlog until manual cleanup: TTL recovers the lease and
 * reconcile redispatches the sync, but neither removes an orphaned queue_jobs
 * row.
 */
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
  // Lifetime hook: receives each detached late-settlement promise (a late
  // acquire-token release, a raced-away send including its ledger
  // compensation). Never affects the dispatch outcome; the caller decides
  // whether to hold it in waitUntil.
  onLateSettlement?: (work: Promise<unknown>) => void,
): Promise<boolean> {
  signal?.throwIfAborted();
  // ShouldBeUnique: a still-queued write-back absorbs this dispatch.
  const key = uniqueKey(eventKey);
  // Failed send: compensate only this acquisition, never a newer holder.
  // Like terminal cleanup, a wedged DELETE must not hold dispatch hostage.
  // TTL recovers a stuck lease; a late DELETE remains fenced by this token.
  const releaseOwnLease = async (lease: string): Promise<void> => {
    let t: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((resolve) => {
      t = setTimeout(resolve, LOCK_TIMEOUT_MS);
    });
    await Promise.race([
      Promise.resolve()
        .then(() => lock.release(key, lease))
        .catch(() => {}),
      timeout,
    ]).finally(() => clearTimeout(t));
  };
  const acquireOp = lock.acquire(key, SYNC_EVENT.uniqueForSeconds);
  let leaseToken: string | null;
  try {
    leaseToken = await withProducerDeadline(acquireOp);
  } catch (err) {
    // A token arriving after the deadline wins is a live row again: attempt to
    // free it (bounded, never throwing). Best-effort only — without Workers
    // lifetime (web path) it can still linger until its TTL, so callers that
    // need the tail to run hold the exposed promise in their own waitUntil.
    // A real acquire rejection carries no token, so the handler is a no-op.
    const lateRelease = acquireOp.then(
      (late) => {
        if (typeof late === "string" && late) return releaseOwnLease(late);
      },
      () => {},
    );
    onLateSettlement?.(lateRelease);
    throw err;
  }
  if (!leaseToken) return false;
  // Hoisted so a deadline rejection can expose the still-in-flight send
  // (including its exact-jobId ledger compensation) to the caller's lifetime.
  // The abort check stays before any send is attempted, inside the try so an
  // abort after acquisition still compensates this token.
  let sendOp: Promise<unknown> | undefined;
  try {
    signal?.throwIfAborted();
    sendOp = queue.send(
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
    await withProducerDeadline(sendOp);
  } catch (err) {
    // The raced-away send still owns its ledger compensation: expose its
    // settlement so a waitUntil holder can cover it. The lease release below
    // stays awaited inside dispatch (bounded), so it needs no hook.
    if (sendOp) {
      onLateSettlement?.(
        sendOp.then(
          () => {},
          () => {},
        ),
      );
    }
    await releaseOwnLease(leaseToken);
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
  // An already-persisted deadline can predate admission and lie outside the
  // queue transport range. Cap it before it becomes the queue delay (and the
  // ledger availability Date); remaining > 0 keeps the 1s floor, the cap sets
  // the 86400s ceiling. Both bounds are integers: remaining is ceiled above.
  if (remaining > 0) return waiting(Math.min(remaining, MAX_RETRY_DELAY_SECONDS));
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
      Promise.resolve(
        observe(
          syncRetryDiagnostic(retryClass, refusalRetryCode(answer), attempts, attempt, claimedAt),
        ),
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
    // Never-mirrored cancel: no Discord object exists, so skip the bot and
    // settle locally. The revision still advances and RSVPs stamp to the
    // attempt's mirrored_at; the stored discord id stays null (no bot revision).
    if (attempt.action === "event.cancel" && attempt.discordEventId === null) {
      await deps.events.completeSync(attempt, null);
      return { done: true };
    }
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
      return await retry(admitRetryDelay(answer.retryAfterSeconds, backoff()));
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
