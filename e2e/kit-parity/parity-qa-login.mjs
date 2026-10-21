// Bounded 429 retry for Kit parity QA logins.
//
// POST /auth/qa/:identity shares the `qa-login` throttle (10/min per runner
// IP, src/throttle.ts) across the whole browser-smoke job: the e2e suite holds
// exactly 10 logins and parity's shared plus isolated logins land in the same
// window, so a 429 here names the budget, not the verdict. Retry 429s only,
// honoring Retry-After into a fresh window, bounded like the staging login
// retry (e2e/qa-request.mjs) and the local sweep login
// (e2e/local-fixture-sweep.mjs). Pure helper: the transport is injected, safe
// to unit-test with node:test alongside e2e/qa-login-retry.test.mjs.

import {
  parseRetryAfterSeconds,
  qaLoginThrottleError,
  QA_LOGIN_MAX_ATTEMPTS,
  sleep,
} from "../qa-login-retry.mjs";

/**
 * POST one parity QA login with bounded 429 retries.
 *
 * Only 429 is retried, honoring the server's Retry-After. Any other status is
 * returned immediately so the caller's own assertion names the verdict — never
 * masked as a throttle failure. Past QA_LOGIN_MAX_ATTEMPTS throttled attempts
 * the shared-budget error is thrown loud. Logical-login counting stays with
 * the caller: once per helper execution, outside the retry loop.
 *
 * @template T the transport's response; must offer status() and headers() like Playwright's APIResponse
 * @param {() => Promise<T>} send one login attempt
 * @param {object} options
 * @param {string} options.identity "qa-member" | "qa-moderator"
 * @param {string} [options.scope] throttle-error scope (default "parity")
 * @param {(ms: number) => Promise<void>} [options.wait] sleep between retries (default sleep)
 * @returns {Promise<T>} the first non-429 response, preserving the transport's type
 */
export async function postParityQaLogin(send, { identity, scope = "parity", wait = sleep }) {
  let retryAfterSeconds = 60;
  for (let attempt = 1; attempt <= QA_LOGIN_MAX_ATTEMPTS; attempt++) {
    const response = await send();
    if (response.status() !== 429) return response;
    retryAfterSeconds = parseRetryAfterSeconds(response.headers());
    if (attempt < QA_LOGIN_MAX_ATTEMPTS) await wait(retryAfterSeconds * 1000);
  }
  throw qaLoginThrottleError(identity, retryAfterSeconds, QA_LOGIN_MAX_ATTEMPTS, scope);
}
