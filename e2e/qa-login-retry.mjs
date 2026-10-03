// Bounded 429 handling for staging QA logins (THROTTLE-SELF-HIT FIX).
//
// POST /auth/qa/:identity carries the shared `qa-login` throttle
// (AUTH_THROTTLE_PER_MINUTE = 10/min per runner IP, src/throttle.ts). Every
// login — good, bad-token, or unknown-identity — spends that budget, so the
// per-file sessions must count their logins and honor Retry-After instead of
// failing the whole spec file on the first 429. Pure helpers only: no browser,
// no token, safe to unit-test with node:test alongside qa-request.test.mjs.

/** Login attempts per identity before the 429 becomes a hard failure. */
export const QA_LOGIN_MAX_ATTEMPTS = 3;

/** Upper bound on a single Retry-After wait: the throttle window is 60 s. */
export const QA_LOGIN_RETRY_AFTER_CAP_SECONDS = 65;

/**
 * Seconds to wait before retrying a throttled QA login. Header lookup is
 * case-insensitive (Playwright lower-cases response header names); unparseable
 * or absent values fall back to the full throttle window.
 *
 * @param {Record<string, string> | undefined} headers response headers
 * @param {number} [fallbackSeconds] wait when the header is missing
 */
export function parseRetryAfterSeconds(headers, fallbackSeconds = 60) {
  let raw;
  if (headers && typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === "retry-after") {
        raw = value;
        break;
      }
    }
  }
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return fallbackSeconds;
  return Math.min(Math.max(parsed, 1), QA_LOGIN_RETRY_AFTER_CAP_SECONDS);
}

/**
 * Hard failure for a QA login still throttled after every retry. Names the
 * shared budget and the fix direction (fewer logins, not harder retries).
 * Carries no token, header, or URL — safe for public failure artifacts.
 *
 * @param {string} identity "qa-member" | "qa-moderator"
 * @param {number} retryAfterSeconds last Retry-After seen
 * @param {number} attempts attempts made
 */
export function qaLoginThrottleError(identity, retryAfterSeconds, attempts) {
  return new Error(
    `staging QA login as ${identity} refused with 429 after ${attempts} attempt(s) ` +
      `(qa-login throttle: 10/min per runner IP; server asked to retry in ${retryAfterSeconds}s). ` +
      `Per-file QA logins exceeded the shared budget — cut the login count ` +
      `(scoped per-file sessions, no global-setup login) rather than retrying harder.`,
  );
}

/** Interruptible sleep for Retry-After waits. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
