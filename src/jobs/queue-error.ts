// Bounded queue failure classification (TOG-11627).
//
// Terminal queue alerts and diagnostics are class-only: bot refusal messages,
// thrown error messages and provider bodies can carry tokens, SQL or personal
// data, so they never reach console output, queue.failing or the ledger.
// Only known failure codes are preserved; unknown provider strings are dropped,
// not alphabet-filtered. Attempt counts and job names are numbers and fixed
// strings, already bounded.
import { exceptionClass } from "../alerts";
import { diagnosticCode } from "../bot/diagnostic-code";

const MAX_CLASS_LENGTH = 100;
const MAX_SCOPE_LENGTH = 200;

/** Diagnostic classification only: never echo arbitrary provider strings. */
export function sanitizeQueueCode(code: unknown): string {
  return diagnosticCode(code);
}

/** Job scope tag (e.g. an event key) with line breaks removed and bounded. */
export function sanitizeQueueScope(value: string): string {
  return value.replace(/[\r\n]+/g, "_").slice(0, MAX_SCOPE_LENGTH);
}

/** Class-only classification of a thrown value, bounded for alert/ledger use. */
export function queueExceptionClass(err: unknown): string {
  return exceptionClass(err).slice(0, MAX_CLASS_LENGTH);
}

/** Terminal bot-owned failure: class only, never the error message. */
export function terminalFailureReason(): string {
  return "BotTerminalError";
}

/** Non-retryable bot refusal: job + classified code, never the provider message. */
export function botRefusalReason(job: string, code: unknown): string {
  return `The bot refused ${job} with \`${sanitizeQueueCode(code)}\``;
}

/** Retryable refusal exhausted over all attempts: job + classified code + count. */
export function botRetryExhaustedReason(job: string, code: unknown, attempts: number): string {
  return `The bot refused ${job} with a retryable \`${sanitizeQueueCode(code)}\` on all ${attempts} attempts.`;
}
