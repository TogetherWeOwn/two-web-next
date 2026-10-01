import type { QueueMessage } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check the carrier shape, not bot policy; legacy keys remain opaque strings. */
export function isQueueMessage(value: unknown): value is QueueMessage {
  if (!isRecord(value) || (value.jobId !== undefined && typeof value.jobId !== "string")) return false;
  switch (value.kind) {
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
