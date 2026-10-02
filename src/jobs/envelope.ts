import { validProbeId } from "../alert-probe-error";
import { safeRequestId } from "../request-log";
import type { QueueMessage } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check the carrier shape, not bot policy; legacy keys remain opaque strings. */
export function isQueueMessage(value: unknown): value is QueueMessage {
  if (!isRecord(value) || (value.jobId !== undefined && typeof value.jobId !== "string")) return false;
  switch (value.kind) {
    case "alert-probe":
      // Synthetic jobs never own ledger rows; accept legacy probes without an ID.
      return value.jobId === undefined && (value.probeId === undefined || validProbeId(value.probeId));
    case "sync-event":
      // Ownership is a Postgres UUID, unlike the opaque legacy identifiers.
      // Missing tokens remain valid for carriers queued before lease fencing.
      return typeof value.eventKey === "string" && typeof value.idempotencyKey === "string"
        && (value.leaseToken === undefined || (typeof value.leaseToken === "string" && value.leaseToken.length === 36
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.leaseToken)));
    case "announcement":
      return typeof value.idempotencyKey === "string" && isRecord(value.action)
        && typeof value.action.channelKey === "string" && typeof value.action.body === "string";
    case "role-assign":
      return value.idempotencyKey === null && isRecord(value.action)
        && typeof value.action.userId === "string" && typeof value.action.roleKey === "string";
    default:
      return false;
  }
}

/**
 * The consumer's view of a carrier: a W13 `QueueMessage` as-is, or the W8
 * write-back `SyncMessage` (src/events/sync.ts — what the RSVP and event
 * routes enqueue) as the sync-event job it stands for. The producer's
 * idempotency key is carried unchanged, so every redelivery asks the bot with
 * the key minted when the write committed. A W8 carrier holds no lease and no
 * ledger row: it releases no lock and stamps no ledger transition, exactly
 * like a pre-fencing sync-event.
 *
 * Only `event.upsert` maps. `event.cancel` has no consumer yet (BotClient has
 * no cancel call), and a sync-event for a cancelled row would ask the bot to
 * upsert it, so a cancel carrier stays unrecognized. Anything carrying `kind`
 * is judged by the W13 shape alone.
 */
export function toQueueMessage(value: unknown): QueueMessage | null {
  if (isQueueMessage(value)) return value;
  if (!isRecord(value) || "kind" in value) return null;
  if (value.action !== "event.upsert" || typeof value.eventKey !== "string"
    || value.dedupeKey !== value.eventKey || typeof value.idempotencyKey !== "string") return null;
  // Keep only a well-formed originating request ID for queue.failing correlation.
  const requestId = safeRequestId(value.requestId);
  return { kind: "sync-event", eventKey: value.eventKey, idempotencyKey: value.idempotencyKey, ...(requestId ? { requestId } : {}) };
}
