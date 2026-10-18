/**
 * Shared closed vocabulary for transport logs and queue failure diagnostics.
 * Provider codes can echo secrets: alphabet/length filtering is not a
 * confidentiality proof. Never retain cleaned substrings of unknown values.
 * The returned BotFailure.code stays raw; only diagnostics are classified.
 */
const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  "malformed",
  "unauthorized",
  "stale_request",
  "action_not_allowed",
  "replayed",
  "in_progress",
  "discord_rejected",
  "rate_limited",
  "internal",
  "discord_unavailable",
  "upstream_timeout",
]);

export function diagnosticCode(code: unknown): string {
  return typeof code === "string" && DIAGNOSTIC_CODES.has(code) ? code : "unknown";
}
