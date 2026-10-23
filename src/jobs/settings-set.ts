import { CALL_INTERNAL_ACTION as C, backoffFor } from "./constants";
import { botRefusalReason, botRetryExhaustedReason, terminalFailureReason } from "./queue-error";
import { withInternalActionDeadline } from "./internal-action-deadline";
import { admitRetryDelay } from "./retry-delay";
import { BotTerminalError, BotTransportError } from "./types";
import type { BotFailure, QueueMessage, SettingsSetResult, SettingsWriter } from "./types";
import type { Outcome } from "./sync-event";

type SettingsSetAnswer = SettingsSetResult | BotFailure;

/**
 * Deliver one queued dashboard settings write to the bot's settings.set.
 * `attempts` is 1-based. Dispositions mirror CallInternalAction: a hung or
 * unreachable bot is a transport wait (bounded by the shared deadline, same
 * carrier key on redelivery), a definitive refusal fails with the verb and
 * code only, and an untrusted retry delay is admitted into the Cloudflare
 * range with the configured backoff as fallback.
 */
export async function handleSettingsSet(
  msg: Extract<QueueMessage, { kind: "settings-set" }>,
  attempts: number,
  writer: SettingsWriter,
): Promise<Outcome> {
  let answer: SettingsSetAnswer;
  try {
    answer = await withInternalActionDeadline<SettingsSetAnswer>(
      writer.setSetting(
        {
          key: msg.action.key,
          value: msg.action.value,
          expectedVersion: msg.action.expected_version,
          actor: msg.actor,
          guildId: msg.guildId,
        },
        msg.idempotencyKey,
      ),
    );
  } catch (e) {
    if (e instanceof BotTransportError) {
      return attempts >= C.tries
        ? { failed: `gave up after ${attempts} attempts` }
        : { retryInSeconds: backoffFor(C.backoffSeconds, attempts) };
    }
    if (e instanceof BotTerminalError) return { failed: terminalFailureReason() };
    throw e;
  }
  if (answer.ok) return { done: true };
  const name = "settings.set";
  if (!answer.retryable) return { failed: botRefusalReason(name, answer.code) };
  if (attempts >= C.tries) {
    return { failed: botRetryExhaustedReason(name, answer.code, attempts) };
  }
  return {
    retryInSeconds: admitRetryDelay(
      answer.retryAfterSeconds,
      backoffFor(C.backoffSeconds, attempts),
    ),
  };
}
