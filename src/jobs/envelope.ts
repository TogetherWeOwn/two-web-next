import { validProbeId } from "../alert-probe-error";
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
      return typeof value.eventKey === "string" && typeof value.idempotencyKey === "string";
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
