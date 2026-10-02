/**
 * Retry-delay admission for queued bot actions (TOG-11629).
 *
 * The bot's `retryAfterSeconds` arrives as untrusted JSON: it is typed
 * `number | null`, but at runtime it can be NaN, infinite, negative,
 * fractional, zero, a string, an object, or absurdly large. Forwarding it
 * unchecked poisons both downstream sinks in src/jobs/consumer.ts, which use
 * the same admitted value: the ledger `availableAt` Date (`new Date(now +
 * s * 1000)` — NaN/Infinity is an Invalid Date) and `Queue.retry({ delaySeconds })`.
 *
 * Cloudflare Queues javascript-apis docs (read 2026-10-01):
 * - send `delaySeconds`: "Must be an integer between 0 and 86400 (24 hours)."
 * - retry `delaySeconds`: "Must be a positive integer." (no max stated)
 * We admit positive integers up to 86400 — the largest delay Cloudflare
 * documents on any queue path. Everything else takes the caller's bounded
 * fallback (the attempt's configured backoff), never the raw value.
 *
 * Fractional values round UP (never retry sooner than the provider asked);
 * zero is out of the retry transport range, so it falls back like any other
 * unusable value.
 */

/** Largest retry delay Cloudflare documents accepting on any queue path (24h). */
export const MAX_RETRY_DELAY_SECONDS = 86400;

export function admitRetryDelay(candidate: unknown, fallbackSeconds: number): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return fallbackSeconds;
  const seconds = Math.ceil(candidate);
  if (seconds < 1 || seconds > MAX_RETRY_DELAY_SECONDS) return fallbackSeconds;
  return seconds;
}
