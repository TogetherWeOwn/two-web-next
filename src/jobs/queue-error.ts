// Bounded queue failure classification (TOG-11627).
//
// Terminal queue alerts and diagnostics are class-only: bot refusal messages,
// thrown error messages and provider bodies can carry tokens, SQL or personal
// data, so they never reach console output, queue.failing or the ledger.
// Stable failure codes are preserved (sanitized to a safe alphabet); nothing
// else from the provider is copied. Attempt counts and job names are numbers
// and fixed strings, already bounded.
import { exceptionClass } from "../alerts";

const MAX_CODE_LENGTH = 64;
const MAX_CLASS_LENGTH = 100;
const MAX_SCOPE_LENGTH = 200;

/** Stable provider code, stripped to a log-safe alphabet and bounded. */
export function sanitizeQueueCode(code: unknown): string {
  if (typeof code !== "string" || code.length === 0) return "unknown";
  const cleaned = code.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MAX_CODE_LENGTH);
  return cleaned.length > 0 ? cleaned : "unknown";
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

/** Non-retryable bot refusal: job + sanitized code, never the provider message. */
export function botRefusalReason(job: string, code: unknown): string {
  return `The bot refused ${job} with \`${sanitizeQueueCode(code)}\``;
}

/** Retryable refusal exhausted over all attempts: job + sanitized code + count. */
export function botRetryExhaustedReason(job: string, code: unknown, attempts: number): string {
  return `The bot refused ${job} with a retryable \`${sanitizeQueueCode(code)}\` on all ${attempts} attempts.`;
}
