import type { SyncAttempt } from "./types";

export type SyncRetryCode =
  | "in_progress"
  | "rate_limited"
  | "internal"
  | "discord_unavailable"
  | "upstream_timeout"
  | "unknown";

export type SyncRetryDiagnostic = {
  sync_retry_class: "BotFailure" | "BotTransportError" | "unknown";
  sync_retry_code?: SyncRetryCode;
  queue_carrier_attempts?: number;
  sync_request_attempts?: number;
  sync_snapshot_age_at_claim_seconds?: number;
};

function record(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function dataField(value: unknown, key: string): unknown {
  try {
    // Sample only own data: observation must not execute input accessors.
    return record(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  } catch {
    return undefined;
  }
}

function retryCode(value: unknown): SyncRetryCode {
  switch (value) {
    case "in_progress":
      return "in_progress";
    case "rate_limited":
      return "rate_limited";
    case "internal":
      return "internal";
    case "discord_unavailable":
      return "discord_unavailable";
    case "upstream_timeout":
      return "upstream_timeout";
    default:
      return "unknown";
  }
}

export function refusalRetryCode(answer: unknown): SyncRetryCode {
  return retryCode(dataField(answer, "code"));
}

const count = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

/** The only projection logs/alerts may spread: no input object or provider string survives. */
export function projectSyncRetryDiagnostic(value: unknown): Partial<SyncRetryDiagnostic> {
  if (!record(value)) return {};
  const retryClass = dataField(value, "sync_retry_class");
  const carrierAttempts = dataField(value, "queue_carrier_attempts");
  const requestAttempts = dataField(value, "sync_request_attempts");
  const snapshotAge = dataField(value, "sync_snapshot_age_at_claim_seconds");
  const fields: SyncRetryDiagnostic = {
    sync_retry_class:
      retryClass === "BotFailure"
        ? "BotFailure"
        : retryClass === "BotTransportError"
          ? "BotTransportError"
          : "unknown",
  };
  if (fields.sync_retry_class === "BotFailure")
    fields.sync_retry_code = retryCode(dataField(value, "sync_retry_code"));
  if (count(carrierAttempts, 1)) fields.queue_carrier_attempts = carrierAttempts;
  if (count(requestAttempts, 0)) fields.sync_request_attempts = requestAttempts;
  if (count(snapshotAge, 0)) fields.sync_snapshot_age_at_claim_seconds = snapshotAge;
  return fields;
}

function timestamp(value: unknown): number {
  try {
    return value instanceof Date ? Date.prototype.getTime.call(value) : NaN;
  } catch {
    return NaN;
  }
}

/** Claim count is not an HTTP-send count; mirroredAt is the snapshot time, not dispatch time. */
export function syncRetryDiagnostic(
  retryClass: "BotFailure" | "BotTransportError",
  code: unknown,
  carrierAttempts: number,
  attempt: Pick<SyncAttempt, "requestAttempts" | "mirroredAt">,
  claimedAt: Date,
): SyncRetryDiagnostic {
  const fields = projectSyncRetryDiagnostic({
    sync_retry_class: retryClass,
    sync_retry_code: code,
    queue_carrier_attempts: carrierAttempts,
    sync_request_attempts: dataField(attempt, "requestAttempts"),
    sync_snapshot_age_at_claim_seconds: Math.floor(
      (timestamp(claimedAt) - timestamp(dataField(attempt, "mirroredAt"))) / 1000,
    ),
  });
  return { ...fields, sync_retry_class: fields.sync_retry_class ?? "unknown" };
}
