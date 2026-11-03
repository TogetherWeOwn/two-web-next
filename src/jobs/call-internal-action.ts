import { CALL_INTERNAL_ACTION as C, backoffFor } from "./constants";
import { botRefusalReason, botRetryExhaustedReason, terminalFailureReason } from "./queue-error";
import { withInternalActionDeadline } from "./internal-action-deadline";
import { isNeedsReconciliation, lastWireOutcome, stuckIntent } from "./reconciliation";
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

/** Producer. Announcements mint a key at dispatch (two dispatches = two announcements, by design); role.assign sends none.
 * The optional echoId threads an Echo row awaiting confirmed delivery: the
 * consumer confirms it only on bot success, never at enqueue time. */
export async function dispatchAnnouncement(
  queue: { send(b: unknown): Promise<unknown> },
  action: Announcement,
  requestId?: string,
  echoId?: number,
) {
  const msg: QueueMessage = {
    kind: "announcement",
    idempotencyKey: crypto.randomUUID(),
    action,
    requestId: safeRequestId(requestId),
    ...(typeof echoId === "number" && Number.isSafeInteger(echoId) && echoId > 0 ? { echoId } : {}),
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

/** Ports CallInternalAction::handle. `attempts` is 1-based.
 * Keyed carriers (announcement.post) never re-key: unknown outcomes retry
 * with the same key to the budget, then escalate as a stuck operator intent;
 * `needs_reconciliation` is an immediate hard stop. Keyless role.assign keeps
 * its existing terminal semantics (no key exists to persist). */
export async function handleCallInternalAction(
  msg: Extract<QueueMessage, { kind: "announcement" | "role-assign" }>,
  attempts: number,
  bot: BotClient,
): Promise<Outcome> {
  const keyed = msg.kind === "announcement";
  const stuckKeyed = (last: {
    code: string | null;
    status: number | null;
    requestId: string | null;
  }): Outcome => ({
    // The keyless branch never reaches here: no key exists to persist.
    stuck: stuckIntent({
      idempotencyKey: (msg as Extract<QueueMessage, { kind: "announcement" }>).idempotencyKey,
      verb: "announcement.post",
      subject: (msg as Extract<QueueMessage, { kind: "announcement" }>).action.channelKey,
      lastCode: last.code,
      lastStatus: last.status,
      lastRequestId: last.requestId,
      attempts: Math.max(1, attempts),
    }),
  });
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
    // max-attempts rule then fails it, which is the same cap. Keyed carriers
    // escalate to the operator surface at the cap instead of a terminal
    // failure: delivery is unconfirmed, never refused.
    if (e instanceof BotTransportError) {
      if (attempts >= C.tries) {
        return keyed
          ? stuckKeyed({ code: null, status: null, requestId: null })
          : { failed: `gave up after ${attempts} attempts` };
      }
      return { retryInSeconds: backoffFor(C.backoffSeconds, attempts) };
    }
    // Class-only: the terminal message can carry tokens or personal data.
    if (e instanceof BotTerminalError) return { failed: terminalFailureReason() };
    throw e;
  }
  if (answer.ok) return { done: true };
  const name = msg.kind === "announcement" ? "announcement.post" : "role.assign";
  // Safe capture first: the hard-stop check and the intent's last outcome
  // share one own-data read that never executes input accessors and
  // classifies the code (garbage escalates as unknown, never wedges).
  const last = lastWireOutcome(answer);
  // Hard stop on the code alone — never the status, never the retryable flag.
  if (keyed && isNeedsReconciliation(last.code)) return stuckKeyed(last);
  // Class-only: keep the stable failure code, never the provider message.
  if (!answer.retryable) return { failed: botRefusalReason(name, answer.code) };
  if (attempts >= C.tries) {
    // Retryable unknowns that never converge escalate with the last wire
    // outcome attached; the Discord state is unconfirmed, never refused.
    // Keyless role.assign keeps its terminal copy unchanged (no key to persist).
    return keyed
      ? stuckKeyed(last)
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
