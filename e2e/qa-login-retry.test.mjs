// qa-login retry helpers for the staging throttle self-hit fix.
//
// Pure helpers only (no browser, no token): Retry-After parsing with the
// throttle-window cap, and the hard-failure error after retries exhaust.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRetryAfterSeconds,
  qaLoginThrottleError,
  QA_LOGIN_MAX_ATTEMPTS,
  QA_LOGIN_RETRY_AFTER_CAP_SECONDS,
} from "./qa-login-retry.mjs";

test("a numeric Retry-After is honored verbatim", () => {
  assert.equal(parseRetryAfterSeconds({ "retry-after": "17" }), 17);
  assert.equal(parseRetryAfterSeconds({ "Retry-After": "7" }), 7);
});

test("a missing or unparseable Retry-After falls back to the window", () => {
  assert.equal(parseRetryAfterSeconds({}), 60);
  assert.equal(parseRetryAfterSeconds(undefined), 60);
  assert.equal(parseRetryAfterSeconds({ "retry-after": "soon" }), 60);
  assert.equal(parseRetryAfterSeconds({ "retry-after": "" }), 60);
});

test("waits are floored at 1s and capped at the window plus margin", () => {
  assert.equal(parseRetryAfterSeconds({ "retry-after": "0" }), 1);
  assert.equal(parseRetryAfterSeconds({ "retry-after": "-5" }), 1);
  assert.equal(parseRetryAfterSeconds({ "retry-after": "3600" }), QA_LOGIN_RETRY_AFTER_CAP_SECONDS);
  assert.ok(QA_LOGIN_RETRY_AFTER_CAP_SECONDS >= 60);
});

test("the throttle error names the budget and carries no secret", () => {
  const error = qaLoginThrottleError("qa-member", 42, QA_LOGIN_MAX_ATTEMPTS);
  assert.match(error.message, /staging QA login as qa-member/);
  assert.match(error.message, /429/);
  assert.match(error.message, /10\/min/);
  assert.match(error.message, /42s/);
  assert.ok(!error.message.includes("X-TWO-QA-Auth"), "header name leaked");
});

test("the retry budget stays small enough to fit the 30s hook window", () => {
  assert.ok(QA_LOGIN_MAX_ATTEMPTS >= 2, "at least one retry across the minute boundary");
  assert.ok(QA_LOGIN_MAX_ATTEMPTS <= 3, "more attempts cannot beat the 30s beforeAll timeout");
});
