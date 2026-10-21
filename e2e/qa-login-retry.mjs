// Bounded 429 handling for staging and local QA logins (THROTTLE-SELF-HIT FIX).
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
 * @param {string} [scope] "staging" (default) or "local"
 */
export function qaLoginThrottleError(identity, retryAfterSeconds, attempts, scope = "staging") {
  return new Error(
    `${scope} QA login as ${identity} refused with 429 after ${attempts} attempt(s) ` +
      `(qa-login throttle: 10/min per runner IP; server asked to retry in ${retryAfterSeconds}s). ` +
      `Per-file QA logins exceeded the shared budget — cut the login count ` +
      `(scoped per-file sessions, no global-setup login) rather than retrying harder.`,
  );
}

/** Interruptible sleep for Retry-After waits. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One QA login POST with bounded 429 retries for specs that post through
 * Playwright (the local browser smoke and Kit parity; staging posts over
 * Node fetch via qa-request.mjs instead, so the token never enters a trace).
 *
 * Only a 429 retries: any other status returns immediately for the caller to
 * assert, so a bad token or a downed worker fails fast with the caller's own
 * message. A refused 429 inserts no throttle row (checkJoinThrottle admits
 * or records under one advisory lock, src/join/service.ts), so each retry
 * spends nothing — it only waits out the window the server names in
 * Retry-After, then the retry is admitted unless a concurrent spender refills
 * the bucket. Past QA_LOGIN_MAX_ATTEMPTS the wait becomes the loud
 * qaLoginThrottleError, which points at cutting logins instead of retrying
 * harder. Callers size their block timeout with qaLoginRetryBudgetMs first:
 * one capped wait already exceeds the 30 s config timeout that also bounds
 * hooks, so without that raise a 429 dies as a hook/test timeout instead of
 * completing its retry.
 *
 * @template T
 * @param {() => Promise<T & { status(): number, headers(): Record<string, string> }>} post one login attempt
 * @param {string} identity "qa-member" | "qa-moderator"
 * @param {string} [scope] "local" (default) or "staging"
 * @returns {Promise<T & { status(): number, headers(): Record<string, string> }>} the first non-429 response
 */
export async function postQaLoginWithRetry(post, identity, scope = "local") {
  let retryAfterSeconds = 60;
  for (let attempt = 1; attempt <= QA_LOGIN_MAX_ATTEMPTS; attempt += 1) {
    const response = await post();
    if (response.status() !== 429) return response;
    retryAfterSeconds = parseRetryAfterSeconds(response.headers());
    if (attempt < QA_LOGIN_MAX_ATTEMPTS) await sleep(retryAfterSeconds * 1000);
  }
  throw qaLoginThrottleError(identity, retryAfterSeconds, QA_LOGIN_MAX_ATTEMPTS, scope);
}

/**
 * Longest the Retry-After waits can take across `loginCount` sequential
 * logins: each login sleeps at most QA_LOGIN_MAX_ATTEMPTS - 1 times, bounded
 * by QA_LOGIN_RETRY_AFTER_CAP_SECONDS. Callers running under a test or hook
 * timeout add this to their normal allowance — the staging config's 30 s
 * timeout also bounds beforeAll hooks, and one capped wait is 65 s, so a
 * login under the bare timeout dies as a hook timeout on the first 429
 * instead of completing its retry (or failing with qaLoginThrottleError).
 * Inside a hook, test.setTimeout raises that hook's own timeout.
 *
 * @param {number} loginCount sequential logins (2 for both QA identities)
 */
export function qaLoginRetryBudgetMs(loginCount) {
  if (!Number.isInteger(loginCount) || loginCount < 1) {
    throw new RangeError(`qaLoginRetryBudgetMs needs a positive login count, got ${loginCount}`);
  }
  return loginCount * (QA_LOGIN_MAX_ATTEMPTS - 1) * QA_LOGIN_RETRY_AFTER_CAP_SECONDS * 1000;
}
