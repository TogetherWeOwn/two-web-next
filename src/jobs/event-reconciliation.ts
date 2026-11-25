import { diagnosticCode } from "../bot/diagnostic-code";
import { backoffFor, LEDGER_DB_TIMEOUT_MS, SYNC_EVENT } from "./constants";
import { reconciliationIntent, type ReconciliationIntent } from "./reconciliation";
import type { SyncAttempt } from "./types";

const RECORDED = "event sync requires reconciliation; original request retained";
const UNCONFIRMED = "event sync reconciliation unconfirmed; original request remains fenced";

type RecordSync = (intent: ReconciliationIntent) => Promise<"recorded" | "stale">;

type EventReconciliationOutcome =
  | { failed: typeof RECORDED }
  | { retryInSeconds: number; alert?: typeof UNCONFIRMED };

/**
 * Dormant until the event claim cutoff and rollback are qualified. Call after
 * an unknown result on the owned claim, or after authoritative handoff of a
 * stranded claim. A deadline, missing timestamp or carrier cap alone cannot
 * authorize handoff.
 *
 * The writer must bind the winning claim fence and confirm its commit. An
 * unconfirmed write only permits redelivery of the settlement, never a send.
 */
export async function reconcileEventSync(
  attempt: SyncAttempt,
  carrierAttempts: number,
  recordSync: RecordSync,
  evidence?: { code: unknown; status: unknown },
): Promise<EventReconciliationOutcome> {
  const retry: EventReconciliationOutcome = {
    retryInSeconds: backoffFor(SYNC_EVENT.backoffSeconds, carrierAttempts),
    ...(carrierAttempts >= SYNC_EVENT.tries ? { alert: UNCONFIRMED } : {}),
  };
  if (
    attempt.state !== "pending" ||
    attempt.nextAttemptAt !== null ||
    (attempt.action !== "event.upsert" && attempt.action !== "event.cancel")
  ) {
    return retry;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = evidence?.status;
    const intent = reconciliationIntent({
      idempotencyKey: attempt.idempotencyKey,
      verb: attempt.action,
      subject: attempt.eventKey,
      attempts: attempt.requestAttempts,
      lastCode: evidence ? diagnosticCode(evidence.code) : null,
      lastStatus:
        typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
          ? status
          : null,
    });
    const deadline = new Promise<"unconfirmed">((resolve) => {
      timer = setTimeout(() => resolve("unconfirmed"), LEDGER_DB_TIMEOUT_MS);
    });
    return (await Promise.race([recordSync(intent), deadline])) === "recorded"
      ? { failed: RECORDED }
      : retry;
  } catch {
    // A failed write or validation leaves the claim pending. The disposition
    // preserves it and reports only a fixed reason at the carrier cap.
    return retry;
  } finally {
    clearTimeout(timer);
  }
}
