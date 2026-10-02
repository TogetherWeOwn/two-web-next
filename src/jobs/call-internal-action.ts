import { CALL_INTERNAL_ACTION as C, backoffFor } from "./constants";
import { botRefusalReason, botRetryExhaustedReason, terminalFailureReason } from "./queue-error";
import { withInternalActionDeadline } from "./internal-action-deadline";
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

type InternalActionAnswer =
  | BotSuccess<{ messageId: string; replayed: boolean }>
  | BotSuccess<{ outcome: string }>
  | BotFailure;

/** Producer. Announcements mint a key at dispatch (two dispatches = two announcements, by design); role.assign sends none. */
export async function dispatchAnnouncement(
  queue: { send(b: unknown): Promise<unknown> },
  action: Announcement,
) {
  const msg: QueueMessage = { kind: "announcement", idempotencyKey: crypto.randomUUID(), action };
  await queue.send(msg);
}
export async function dispatchRoleAssign(
  queue: { send(b: unknown): Promise<unknown> },
  action: RoleAssignment,
) {
  const msg: QueueMessage = { kind: "role-assign", idempotencyKey: null, action };
  await queue.send(msg);
}

/** Ports CallInternalAction::handle. `attempts` is 1-based. */
export async function handleCallInternalAction(
  msg: Extract<QueueMessage, { kind: "announcement" | "role-assign" }>,
  attempts: number,
  bot: BotClient,
): Promise<Outcome> {
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
