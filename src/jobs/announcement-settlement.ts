import { diagnosticCode } from "../bot/diagnostic-code";
import { safeRequestId } from "../request-log";
import { validAnnouncementAttempt, validAnnouncementKey } from "./reconciliation";

/** A recovery carrier has only the original identity, fencing attempt and diagnostics. */
export type AnnouncementSettlement = {
  kind: "announcement-settlement";
  idempotencyKey: string;
  sendAttempts: number;
  lastCode: string | null;
  lastStatus: number | null;
  jobId?: string;
  requestId?: string;
};

/** Only the opted-in consumer parses settlement carriers. */
export function toAnnouncementSettlement(value: unknown): AnnouncementSettlement | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { kind, idempotencyKey, sendAttempts, lastCode, lastStatus, jobId, requestId } =
    value as Record<string, unknown>;
  if (
    kind !== "announcement-settlement" ||
    !validAnnouncementKey(idempotencyKey) ||
    !validAnnouncementAttempt(sendAttempts) ||
    (jobId !== undefined && !validAnnouncementKey(jobId)) ||
    (lastCode === null && lastStatus === null) ||
    (lastCode !== null &&
      (typeof lastCode !== "string" || lastCode !== diagnosticCode(lastCode))) ||
    (lastStatus !== null &&
      (typeof lastStatus !== "number" ||
        !Number.isInteger(lastStatus) ||
        lastStatus < 100 ||
        lastStatus > 599))
  )
    return null;
  return {
    kind,
    idempotencyKey,
    sendAttempts,
    lastCode,
    lastStatus,
    jobId,
    requestId: safeRequestId(requestId),
  };
}
