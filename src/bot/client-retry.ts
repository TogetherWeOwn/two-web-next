/**
 * The bot's error codes (two-bot docs/INTERNAL_ACTIONS.md §2). The `retryable`
 * flag on the wire is authoritative; this table is only the fallback when the
 * flag is missing — and false for a code we do not know. Never branch on HTTP
 * status: `in_progress` and `replayed` are both 409 with opposite answers.
 */
export function retryableFallback(code: string): boolean {
  switch (code) {
    case "in_progress":
    case "rate_limited":
    case "internal":
    case "discord_unavailable":
    case "upstream_timeout":
      return true;
    // Hard stop: the bot's key log disagrees with this request, so retrying —
    // same key or re-keyed — can never converge. Surface to moderators instead.
    case "needs_reconciliation":
      return false;
    default:
      return false;
  }
}
