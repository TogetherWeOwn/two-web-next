// Event mutations share W13's tracked, unique queue carrier. The message holds
// identity only: the consumer reads the current row after the 10 s debounce,
// so an edit followed by cancellation sends event.cancel, never stale upsert.
import type { Env } from "../env";
import type { EventStatus } from "../admin/validation";
import { safeRequestId } from "../request-log";
import type { QueueMessage } from "../jobs/types";
import { enqueueSyncEvent } from "../jobs/worker";

export function buildSyncMessage(
  eventKey: string,
  status: EventStatus,
  requestId?: string,
): Extract<QueueMessage, { kind: "sync-event" }> | null {
  if (status !== "published" && status !== "cancelled") return null;
  // Fixed at build time; every retry carries this same key. Correlation rides
  // alongside, never as the key; absent for scheduled/reconcile/legacy calls.
  return {
    kind: "sync-event",
    eventKey,
    idempotencyKey: crypto.randomUUID(),
    requestId: safeRequestId(requestId),
  };
}

/** Never roll back a committed event because its write-back carrier failed. */
export async function enqueueEventSync(
  env: Env,
  eventKey: string,
  status: EventStatus,
  requestId?: string,
) {
  const message = buildSyncMessage(eventKey, status, requestId);
  if (!message) return null;
  if (!env.SYNC_EVENT_QUEUE) {
    console.warn("event write-back due but SYNC_EVENT_QUEUE is not bound", {
      eventKey,
      request_id: message.requestId,
    });
    return message;
  }
  try {
    await enqueueSyncEvent(env, message);
  } catch (err) {
    console.error("event write-back enqueue failed; reconcile will re-dispatch", {
      eventKey,
      exception: err instanceof Error ? err.name : typeof err,
      request_id: message.requestId,
    });
  }
  return message;
}
