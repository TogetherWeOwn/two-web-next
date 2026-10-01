import { CALL_INTERNAL_ACTION as C, backoffFor } from "./constants";
import { admitRetryDelay } from "./retry-delay";
import { BotTerminalError, BotTransportError } from "./types";
import type { Announcement, BotClient, QueueMessage, RoleAssignment } from "./types";
import type { Outcome } from "./sync-event";

/** Producer. Announcements mint a key at dispatch (two dispatches = two announcements, by design); role.assign sends none. */
export async function dispatchAnnouncement(queue: { send(b: unknown): Promise<unknown> }, action: Announcement) {
  const msg: QueueMessage = { kind: "announcement", idempotencyKey: crypto.randomUUID(), action };
  await queue.send(msg);
}
export async function dispatchRoleAssign(queue: { send(b: unknown): Promise<unknown> }, action: RoleAssignment) {
  const msg: QueueMessage = { kind: "role-assign", idempotencyKey: null, action };
  await queue.send(msg);
}

/** Ports CallInternalAction::handle. `attempts` is 1-based. */
export async function handleCallInternalAction(
  msg: Extract<QueueMessage, { kind: "announcement" | "role-assign" }>,
  attempts: number,
  bot: BotClient,
): Promise<Outcome> {
  let answer;
  try {
    answer =
      msg.kind === "announcement"
        ? await bot.postAnnouncement(msg.action, msg.idempotencyKey)
        : await bot.assignRole(msg.action);
  } catch (e) {
    // Transport: a wait. Laravel release()s here with no tries check of its own; the worker's
    // max-attempts rule then fails it, which is the same cap.
    if (e instanceof BotTransportError) {
      return attempts >= C.tries
        ? { failed: `gave up after ${attempts} attempts` }
        : { retryInSeconds: backoffFor(C.backoffSeconds, attempts) };
    }
    if (e instanceof BotTerminalError) return { failed: e.message };
    throw e;
  }
  if (answer.ok) return { done: true };
  const name = msg.kind === "announcement" ? "announcement.post" : "role.assign";
  if (!answer.retryable) return { failed: `The bot refused ${name} with \`${answer.code}\`: ${answer.message}` };
  if (attempts >= C.tries) {
    return { failed: `The bot refused ${name} with a retryable \`${answer.code}\` on all ${attempts} attempts.` };
  }
  // The bot's number is untrusted JSON: admit it into the Cloudflare retry
  // range, falling back to this attempt's configured backoff (TOG-11629).
  // The admitted value feeds both the ledger `availableAt` Date and
  // `Queue.retry({ delaySeconds })` in the consumer, which share it.
  return { retryInSeconds: admitRetryDelay(answer.retryAfterSeconds, backoffFor(C.backoffSeconds, attempts)) };
}
