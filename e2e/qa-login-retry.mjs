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
 * Run one QA login with bounded 429 retries for callers inside a Playwright
 * test or hook (kit-parity): the parity journeys run after the browser suite
 * in the same browser-smoke job, so the shared `qa-login` window can still be
 * hot from the journeys' logins when parity logs in. Each 429 waits out the
 * server's Retry-After; only 429 retries, so a wrong token or unknown
 * identity still fails fast on the caller's own 204 assertion, and attempts
 * past the first never fire when the window is cold. Callers raise their
 * block timeout by qaLoginRetryBudgetMs first — one capped wait alone
 * outlasts the 30 s hook/test budget. Transport-agnostic: `attempt` performs
 * one login POST and resolves its response, so node:test covers this with a
 * fake `{ status(), headers() }` and no browser.
 *
 * @template T
 * @param {string} identity "qa-member" | "qa-moderator"
 * @param {() => Promise<T>} attempt one login POST
 * @param {object} [options]
 * @param {string} [options.scope] "staging" (default) or "local"
 * @param {number} [options.maxAttempts] attempts before the 429 is a hard failure
 * @param {(ms: number) => Promise<void>} [options.wait] sleep, injectable for tests
 * @returns {Promise<T>} the first non-429 response
 */
export async function retryQaLoginOn429(
  identity,
  attempt,
  { scope = "staging", maxAttempts = QA_LOGIN_MAX_ATTEMPTS, wait = sleep } = {},
) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`retryQaLoginOn429 needs a positive attempt count, got ${maxAttempts}`);
  }
  let retryAfterSeconds = 60;
  for (let n = 1; n <= maxAttempts; n++) {
    const response = await attempt();
    if (response.status() !== 429) return response;
    retryAfterSeconds = parseRetryAfterSeconds(response.headers());
    if (n < maxAttempts) await wait(retryAfterSeconds * 1000);
  }
  throw qaLoginThrottleError(identity, retryAfterSeconds, maxAttempts, scope);
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
