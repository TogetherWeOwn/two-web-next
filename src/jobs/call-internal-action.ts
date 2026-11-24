import {
  ANNOUNCEMENT_RECONCILIATION_REASON,
  CALL_INTERNAL_ACTION as C,
  backoffFor,
} from "./constants";
import { botRefusalReason, botRetryExhaustedReason, terminalFailureReason } from "./queue-error";
import { withInternalActionDeadline } from "./internal-action-deadline";
import { diagnosticCode } from "../bot/diagnostic-code";
import type { ReconciliationIntent } from "./reconciliation";
import { admitRetryDelay } from "./retry-delay";
import { BotTerminalError, BotTransportError } from "./types";
import type {
  Announcement,
  BotClient,
  BotFailure,
  BotSuccess,
  QueueMessage,
  RoleAssignment,
} from "./types";
import type { Outcome } from "./sync-event";
import { safeRequestId } from "../request-log";

type InternalActionAnswer =
  | BotSuccess<{ messageId: string; replayed: boolean }>
  | BotSuccess<{ outcome: string }>
  | BotFailure;

/** Producer. Announcements mint a key at dispatch (two dispatches = two announcements, by design); role.assign sends none. */
export async function dispatchAnnouncement(
  queue: { send(b: unknown): Promise<unknown> },
  action: Announcement,
  requestId?: string,
) {
  const msg: QueueMessage = {
    kind: "announcement",
    idempotencyKey: crypto.randomUUID(),
    action,
    requestId: safeRequestId(requestId),
  };
  await queue.send(msg);
}
export async function dispatchRoleAssign(
  queue: { send(b: unknown): Promise<unknown> },
  action: RoleAssignment,
  requestId?: string,
) {
  const msg: QueueMessage = {
    kind: "role-assign",
    idempotencyKey: null,
    action,
    requestId: safeRequestId(requestId),
  };
  await queue.send(msg);
}

type ReconciliationOutcome = {
  failed: string;
  announcementEvidence: Pick<ReconciliationIntent, "lastCode" | "lastStatus">;
};

const DEFINITIVE_ANNOUNCEMENT_REFUSALS = new Set([
  "malformed",
  "unauthorized",
  "stale_request",
  "action_not_allowed",
  "discord_rejected",
]);

function reconcileAnnouncement(answer?: BotFailure): ReconciliationOutcome {
  return {
    failed: ANNOUNCEMENT_RECONCILIATION_REASON,
    announcementEvidence: {
      lastCode: answer ? diagnosticCode(answer.code) : null,
      lastStatus: answer?.status ?? null,
    },
  };
}

/** Ports CallInternalAction::handle. `attempts` is 1-based. */
export async function handleCallInternalAction(
  msg: Extract<QueueMessage, { kind: "announcement" | "role-assign" }>,
  attempts: number,
  bot: BotClient,
  claimBacked = false,
): Promise<Outcome | ReconciliationOutcome> {
  const claimedAnnouncement = claimBacked && msg.kind === "announcement";
  let answer: InternalActionAnswer;
  try {
    // Bounded: a never-settling bot round-trip must not stall the serial
    // batch behind it. The deadline fails as a transport wait (same
    // disposition as "bot down"); it never implies the remote call rolled
    // back, and the carrier (idempotency key) is untouched for redelivery.
    answer = await withInternalActionDeadline<InternalActionAnswer>(
      msg.kind === "announcement"
        ? bot.postAnnouncement(msg.action, msg.idempotencyKey)
        : bot.assignRole(msg.action),
    );
  } catch (e) {
    // Transport: a wait. Laravel release()s here with no tries check of its own; the worker's
    // max-attempts rule then fails it, which is the same cap.
    if (e instanceof BotTransportError) {
      if (claimedAnnouncement) return reconcileAnnouncement();
      return attempts >= C.tries
        ? { failed: `gave up after ${attempts} attempts` }
        : { retryInSeconds: backoffFor(C.backoffSeconds, attempts) };
    }
    // Class-only: the terminal message can carry tokens or personal data.
    if (e instanceof BotTerminalError) return { failed: terminalFailureReason() };
    throw e;
  }
  if (answer.ok) return { done: true };
  const name = msg.kind === "announcement" ? "announcement.post" : "role.assign";
  if (claimedAnnouncement) {
    // Only the bot's explicit throttling result allows another same-key send.
    // A transport timeout, duplicate in flight, or hard stop proves no such thing.
    if (!answer.retryable && DEFINITIVE_ANNOUNCEMENT_REFUSALS.has(answer.code))
      return { failed: botRefusalReason(name, answer.code) };
    if (
      answer.code !== "rate_limited" ||
      answer.status !== 429 ||
      !answer.retryable ||
      attempts >= C.tries
    )
      return reconcileAnnouncement(answer);
  }
  // Class-only: keep the stable failure code, never the provider message.
  if (!answer.retryable) return { failed: botRefusalReason(name, answer.code) };
  if (attempts >= C.tries) {
    return { failed: botRetryExhaustedReason(name, answer.code, attempts) };
  }
  // The bot's number is untrusted JSON: admit it into the Cloudflare retry
  // range, falling back to this attempt's configured backoff (TOG-11629).
  // The admitted value feeds both the ledger `availableAt` Date and
  // `Queue.retry({ delaySeconds })` in the consumer, which share it.
  return {
    retryInSeconds: admitRetryDelay(
      answer.retryAfterSeconds,
      backoffFor(C.backoffSeconds, attempts),
    ),
  };
}
