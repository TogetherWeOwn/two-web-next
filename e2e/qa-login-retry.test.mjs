// qa-login retry helpers for the staging throttle self-hit fix.
//
// Pure helpers only (no browser, no token): Retry-After parsing with the
// throttle-window cap, and the hard-failure error after retries exhaust.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseRetryAfterSeconds,
  postQaLoginWithRetry,
  qaLoginRetryBudgetMs,
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

test("the throttle error names a local scope when asked", () => {
  const error = qaLoginThrottleError("qa-moderator", 3, QA_LOGIN_MAX_ATTEMPTS, "local");
  assert.match(error.message, /local QA login as qa-moderator/);
  assert.match(error.message, /429/);
});

test("the retry count stays bounded so the total wait stays bounded", () => {
  assert.ok(QA_LOGIN_MAX_ATTEMPTS >= 2, "at least one retry across the minute boundary");
  assert.ok(QA_LOGIN_MAX_ATTEMPTS <= 3, "more attempts only stretch a throttled run");
});

test("the retry budget covers every capped wait, per sequential login", () => {
  const perLogin = (QA_LOGIN_MAX_ATTEMPTS - 1) * QA_LOGIN_RETRY_AFTER_CAP_SECONDS * 1000;
  assert.equal(qaLoginRetryBudgetMs(1), perLogin);
  assert.equal(qaLoginRetryBudgetMs(2), 2 * perLogin);
  // One capped wait alone already exceeds the staging config's 30 s test
  // timeout, which also bounds hooks — that gap is the failure this covers.
  assert.ok(perLogin > 30_000, "a single login's waits must outlast the 30s hook window");
});

test("the retry budget rejects a non-count instead of returning a bogus timeout", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, undefined]) {
    assert.throws(() => qaLoginRetryBudgetMs(bad), RangeError, `loginCount=${bad}`);
  }
});

// Minimal Playwright APIResponse shape: postQaLoginWithRetry reads only
// status() and headers(), so fakes stay small and the helper stays
// transport-agnostic.
function fakeResponse(status, headers = {}) {
  return { status: () => status, headers: () => headers };
}

test("a first-attempt login returns without waiting", async () => {
  let calls = 0;
  const started = Date.now();
  const response = await postQaLoginWithRetry(
    () => {
      calls += 1;
      return Promise.resolve(fakeResponse(204));
    },
    "qa-member",
    "local",
  );
  assert.equal(response.status(), 204);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1000, "no Retry-After wait on success");
});

test("a non-429 failure returns immediately for the caller to assert", async () => {
  let calls = 0;
  const response = await postQaLoginWithRetry(
    () => {
      calls += 1;
      return Promise.resolve(fakeResponse(500));
    },
    "qa-member",
    "local",
  );
  assert.equal(response.status(), 500);
  assert.equal(calls, 1);
});

test("a 429 waits out Retry-After once, then the retry is admitted", async () => {
  let calls = 0;
  const started = Date.now();
  const response = await postQaLoginWithRetry(
    () => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? fakeResponse(429, { "retry-after": "1" }) : fakeResponse(204),
      );
    },
    "qa-moderator",
    "local",
  );
  assert.equal(response.status(), 204);
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 1000, "the Retry-After second was honored");
});

test("a still-throttled login fails loud after the bounded attempts", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      postQaLoginWithRetry(
        () => {
          calls += 1;
          return Promise.resolve(fakeResponse(429, { "retry-after": "1" }));
        },
        "qa-member",
        "local",
      ),
    /local QA login as qa-member refused with 429 after 3 attempt\(s\)/,
  );
  assert.equal(calls, QA_LOGIN_MAX_ATTEMPTS);
});

// Static guard, qa-login-budget.test.mjs style: the staging config's 30 s
// timeout also bounds beforeAll hooks, and one capped Retry-After wait is
// 65 s, so any staging login running under the bare config timeout fails as
// a hook/test timeout instead of completing its bounded retry (or failing
// with qaLoginThrottleError). Every login call site in a staging spec must
// raise its block's timeout first, sized by that call's own login count.
test("every staging spec login raises its block timeout by the retry budget first", () => {
  const stagingDir = new URL("./staging/", import.meta.url);
  const files = readdirSync(stagingDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.ts"))
    .map((entry) => entry.name)
    .sort();
  assert.ok(files.length > 0, "no staging spec files found");
  let logins = 0;
  for (const file of files) {
    const source = readFileSync(new URL(file, stagingDir), "utf8");
    const blockStarts = [...source.matchAll(/(^|\n)\s*test(?:\.beforeAll)?\s*\(/g)].map(
      (match) => match.index,
    );
    for (const login of source.matchAll(/await\s+loginQa(Identities|Member|Moderator)\s*\(/g)) {
      logins++;
      const expected = login[1] === "Identities" ? 2 : 1;
      const blockStart = blockStarts.filter((start) => start < login.index).at(-1) ?? -1;
      // Both logins inside loginQaIdentities wait, so its budget counts two;
      // a too-small count here reopens the exact structural mismatch.
      const budgetCall = `qaLoginRetryBudgetMs(${expected})`;
      const raised =
        source.lastIndexOf(budgetCall, login.index) > blockStart &&
        source.lastIndexOf("test.setTimeout(", login.index) > blockStart;
      assert.ok(
        raised,
        `${file}: loginQa${login[1]} is not preceded in its block by ` +
          `test.setTimeout(<base> + ${budgetCall}). Without that raise a 429 + ` +
          `Retry-After dies on the bare 30s timeout instead of completing the ` +
          `bounded retry.`,
      );
    }
  }
  assert.ok(logins > 0, "no staging spec logins found — the guard would pass vacuously");
});
