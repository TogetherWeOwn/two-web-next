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

/**
 * One shared `retry-after` response-header parser for every 429 transport:
 * the Discord OAuth path (`src/discord.ts`, surfaced as
 * `DiscordError.retryAfter`), the live scheduled-events reader
 * (`src/events/discord-transients-live.ts`, surfaced as
 * `ReadFailure.retryAfter`), and the signed bot transport
 * (`src/bot/client-transport.ts`, surfaced as
 * `BotFailure.retryAfterSeconds` with `undefined` adapted to `null`).
 *
 * Numeric-only delta-seconds — trimmed digits with an optional fraction
 * (no HTTP dates, signs, exponents, units or markup) — then the same
 * admission posture as `admitRetryDelay`: fractions round UP so the caller
 * never retries sooner than the provider asked, values that ceil below 1
 * second are unusable, and representable-but-absurd values cap at
 * `MAX_RETRY_DELAY_SECONDS` instead of echoing raw. Anything unusable
 * yields `undefined` so the caller keeps its existing headerless/fallback
 * behavior. Callers gate on status themselves: only a 429 carries backoff.
 */
export function parseRetryAfterSeconds(header: string | null | undefined): number | undefined {
  // `Number(null)` and `Number("")` are 0: an absent header must not read as backoff.
  const raw = header?.trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const n = Number(raw);
  // Only representable numeric delays are valid; no HTTP dates or infinity.
  if (!Number.isFinite(n) || n * 1000 > 8_000_000_000_000_000) return undefined;
  const seconds = Math.ceil(n);
  if (seconds < 1) return undefined;
  return Math.min(seconds, MAX_RETRY_DELAY_SECONDS);
}
