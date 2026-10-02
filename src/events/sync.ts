// Discord write-back carrier (W8). Ports two-web app/Jobs/SyncEventToDiscord.php's
// queue semantics onto Cloudflare Queues:
//
//  - unique per eventKey: `dedupeKey` is the event key, so a consumer collapses a burst
//    of messages for one event into one bot call (legacy ShouldBeUnique, uniqueFor 300s);
//  - debounce: every message is delayed DEBOUNCE_SECONDS (legacy: 10 s);
//  - idempotency key minted when the message is BUILT, never per attempt: a retry after a
//    timeout we never saw the answer to must carry the same key or the bot creates a second
//    Discord event;
//  - the action is decided from the row status at send time: cancelled leaves Discord through
//    `event.cancel`, never `event.upsert`; drafts never sync.
//
// W13 owns the consumer (bot contract pending: Rust rewrite). These constants are the
// stub-with-identical-keys the W8 card allows; W13 replaces the values, not the shape.

import type { Env } from "../env";
import type { EventStatus } from "../admin/validation";
import { safeRequestId } from "../request-log";

export const SYNC_DEBOUNCE_SECONDS = 10;
export const SYNC_UNIQUE_FOR_SECONDS = 300;
export const SYNC_TRIES = 6;
/** Gaps between attempts: 10s, 1m, 5m, 15m, 1h; holds at the last value past the end. */
export const SYNC_BACKOFF_SECONDS = [10, 60, 300, 900, 3600] as const;

export type SyncAction = "event.upsert" | "event.cancel";

export type SyncMessage = {
  /** Uniqueness key: one in-flight sync per event. */
  dedupeKey: string;
  eventKey: string;
  action: SyncAction;
  /** Fixed at build time and carried unchanged across every retry. */
  idempotencyKey: string;
  /** Originating HTTP request; optional for scheduled/legacy messages. */
  requestId?: string;
};

/** The queue producer binding (Cloudflare Queues). Optional until the queue is provisioned. */
export type SyncQueue = { send(message: SyncMessage, options?: { delaySeconds?: number }): Promise<void> };

export function actionFor(status: EventStatus): SyncAction | null {
  if (status === "published") return "event.upsert";
  if (status === "cancelled") return "event.cancel";
  // Drafts were never announced (syncing would publish early); past is Discord's to forget.
  return null;
}

export function buildSyncMessage(eventKey: string, status: EventStatus, requestId?: string): SyncMessage | null {
  const action = actionFor(status);
  if (!action) return null;
  return { dedupeKey: eventKey, eventKey, action, idempotencyKey: crypto.randomUUID(), requestId: safeRequestId(requestId) };
}

export function nextBackoffSeconds(attempt: number): number {
  return SYNC_BACKOFF_SECONDS[attempt - 1] ?? SYNC_BACKOFF_SECONDS[SYNC_BACKOFF_SECONDS.length - 1]!;
}

type EnvWithQueue = Env & { EVENT_SYNC_QUEUE?: SyncQueue };

/**
 * Enqueue the write-back. Without a queue binding (unprovisioned environments, local dev)
 * it logs the due sync so a transition without a carrier is visible, never silent.
 * Never throws: the row is committed and correct, the reconcile pass (W13) is the backstop.
 */
export async function enqueueEventSync(env: Env, eventKey: string, status: EventStatus, requestId?: string): Promise<SyncMessage | null> {
  const message = buildSyncMessage(eventKey, status, requestId);
  if (!message) return null;
  const queue = (env as EnvWithQueue).EVENT_SYNC_QUEUE;
  if (!queue) {
    console.warn("event write-back due but EVENT_SYNC_QUEUE is not bound", { eventKey, action: message.action, request_id: message.requestId });
    return message;
  }
  try {
    await queue.send(message, { delaySeconds: SYNC_DEBOUNCE_SECONDS });
  } catch (err) {
    console.error("event write-back enqueue failed; reconcile will re-dispatch", {
      eventKey, exception: err instanceof Error ? err.name : typeof err, request_id: message.requestId,
    });
  }
  return message;
}
