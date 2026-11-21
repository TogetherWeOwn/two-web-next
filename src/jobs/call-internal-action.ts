import { CALL_INTERNAL_ACTION as C, backoffFor } from "./constants";
import { botRefusalReason, botRetryExhaustedReason, terminalFailureReason } from "./queue-error";
import { withInternalActionDeadline } from "./internal-action-deadline";
import { announcementIntent, type ReconciliationIntent } from "./reconciliation";
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

export const ANNOUNCEMENT_RECONCILIATION_REASON = "announcement.post requires reconciliation";

type ReconciliationOutcome = { failed: string; announcementIntent: ReconciliationIntent };

function reconcileAnnouncement(
  msg: Extract<QueueMessage, { kind: "announcement" }>,
  attempts: number,
  answer?: BotFailure,
): ReconciliationOutcome {
  return {
    failed: ANNOUNCEMENT_RECONCILIATION_REASON,
    announcementIntent: announcementIntent(
      msg.idempotencyKey,
      msg.action.channelKey,
      attempts,
      answer,
    ),
  };
}

/** Ports CallInternalAction::handle. `attempts` is 1-based. */
export async function handleCallInternalAction(
  msg: Extract<QueueMessage, { kind: "announcement" | "role-assign" }>,
  attempts: number,
  bot: BotClient,
): Promise<Outcome | ReconciliationOutcome> {
  // Once the carrier passes the bot budget, only local persistence can retry.
  if (msg.kind === "announcement" && attempts > C.tries)
    return reconcileAnnouncement(msg, attempts);

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
      if (attempts < C.tries) return { retryInSeconds: backoffFor(C.backoffSeconds, attempts) };
      return msg.kind === "announcement"
        ? reconcileAnnouncement(msg, attempts)
        : { failed: `gave up after ${attempts} attempts` };
    }
    // Class-only: the terminal message can carry tokens or personal data.
    if (e instanceof BotTerminalError) return { failed: terminalFailureReason() };
    throw e;
  }
  if (answer.ok) return { done: true };
  const name = msg.kind === "announcement" ? "announcement.post" : "role.assign";
  // A keyed hard stop must win over a contradictory wire retry flag or status.
  if (msg.kind === "announcement" && answer.code === "needs_reconciliation")
    return reconcileAnnouncement(msg, attempts, answer);
  const unknownAnnouncement =
    msg.kind === "announcement" &&
    (answer.code === "in_progress" ||
      answer.code === "upstream_timeout" ||
      answer.code === "unavailable");
  // Class-only: keep the stable failure code, never the provider message.
  if (!answer.retryable && !unknownAnnouncement)
    return { failed: botRefusalReason(name, answer.code) };
  if (attempts >= C.tries) {
    return msg.kind === "announcement"
      ? reconcileAnnouncement(msg, attempts, answer)
      : { failed: botRetryExhaustedReason(name, answer.code, attempts) };
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
