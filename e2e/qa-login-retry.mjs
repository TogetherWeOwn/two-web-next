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
 * POST one QA login through an injected sender, honoring Retry-After on 429
 * instead of failing the spec on the first refusal. The local browser smoke
 * shares one `qa-login` bucket (10/min sliding per runner IP) across the
 * journey specs, the fixture-sweep teardown, and kit-parity: the parity
 * logins land while journey-tail spends slide out, so a 429 there means
 * seconds of wait, not a blown budget. Each wait clamps to
 * `singleWaitCapSeconds` so the bounded attempts fit a 30 s test/hook
 * timeout; past the attempts it fails loud with the shared-budget error.
 * A non-429 answer returns at once — the caller asserts the 204 in its own
 * spec, so the status contract stays a spec assertion, not a helper throw.
 *
 * @template T the sender's response type (Playwright APIResponse at call sites)
 * @param {() => Promise<T>} send injected POST returning a status()/headers() response
 * @param {string} identity "qa-member" | "qa-moderator" (throttle-error context only)
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts] default QA_LOGIN_MAX_ATTEMPTS
 * @param {number} [opts.singleWaitCapSeconds] per-wait clamp, default 5
 * @param {(ms: number) => Promise<void>} [opts.wait] default sleep (injectable for tests)
 * @param {string} [opts.scope] throttle-error scope, default "local"
 * @returns {Promise<T>} the final response: 204, or a non-429 refusal for the caller to assert on
 */
export async function postQaLoginWithRetry(send, identity, opts = {}) {
  const {
    maxAttempts = QA_LOGIN_MAX_ATTEMPTS,
    singleWaitCapSeconds = 5,
    wait = sleep,
    scope = "local",
  } = opts;
  let retryAfterSeconds = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await send();
    const status = response.status();
    if (status !== 429) return response;
    retryAfterSeconds = parseRetryAfterSeconds(response.headers());
    if (attempt === maxAttempts) break;
    await wait(Math.min(retryAfterSeconds, singleWaitCapSeconds) * 1000);
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
