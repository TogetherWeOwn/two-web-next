// qa-login retry helpers for the staging throttle self-hit fix.
//
// Pure helpers only (no browser, no token): Retry-After parsing with the
// throttle-window cap, and the hard-failure error after retries exhaust.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseRetryAfterSeconds,
  qaLoginRetryBudgetMs,
  qaLoginThrottleError,
  retryQaLoginOn429,
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

// Fake Playwright login responses for retryQaLoginOn429: the helper only
// reads status() and headers(), so no browser is needed.
const loginOk = (status) => ({ status: () => status, headers: () => ({}) });
const loginThrottled = (retryAfter) => ({
  status: () => 429,
  headers: () => ({ "retry-after": retryAfter }),
});

test("the 429 retry returns the first success without waiting", async () => {
  const waits = [];
  const response = await retryQaLoginOn429("qa-member", async () => loginOk(204), {
    scope: "local",
    wait: async (ms) => void waits.push(ms),
  });
  assert.equal(response.status(), 204);
  assert.deepEqual(waits, []);
});

test("the 429 retry honors each Retry-After before the success", async () => {
  const waits = [];
  let calls = 0;
  const response = await retryQaLoginOn429(
    "qa-member",
    async () => {
      calls += 1;
      return calls < 3 ? loginThrottled("9") : loginOk(204);
    },
    { scope: "local", wait: async (ms) => void waits.push(ms) },
  );
  assert.equal(response.status(), 204);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [9000, 9000]);
});

test("the 429 retry throws the budget error once attempts exhaust", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(
    () =>
      retryQaLoginOn429(
        "qa-moderator",
        async () => {
          calls += 1;
          return loginThrottled("4");
        },
        { scope: "local", wait: async (ms) => void waits.push(ms) },
      ),
    /local QA login as qa-moderator refused with 429 after 3 attempt\(s\)/,
  );
  assert.equal(calls, QA_LOGIN_MAX_ATTEMPTS);
  assert.equal(waits.length, QA_LOGIN_MAX_ATTEMPTS - 1);
  assert.deepEqual(waits, [4000, 4000]);
});

test("the 429 retry never retries a non-429 failure", async () => {
  const waits = [];
  let calls = 0;
  const response = await retryQaLoginOn429(
    "qa-member",
    async () => {
      calls += 1;
      return loginOk(500);
    },
    { wait: async (ms) => void waits.push(ms) },
  );
  assert.equal(response.status(), 500);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test("the 429 retry rejects a non-count instead of a bogus attempt run", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      () => retryQaLoginOn429("qa-member", async () => loginOk(204), { maxAttempts: bad }),
      RangeError,
      `maxAttempts=${bad}`,
    );
  }
});

// Static guard, staging-guard style: parity's two QA logins run after the
// browser suite in the same browser-smoke job, so their bounded 429 retries
// can outlast the bare 30 s hook/test budget. The shared login fires once,
// memoized, on the beforeAll RSVP (later memberGoingRsvp calls replay the
// same promise and never log in), and the isolated renewal login fires in
// its own test — one login per block. Both blocks must raise their timeout
// by their own retry budget first, or a hot window dies as a hook/test
// timeout instead of completing the retry (or failing with
// qaLoginThrottleError).
test("every kit-parity login block raises its timeout by the retry budget first", () => {
  const source = readFileSync(new URL("./kit-parity/parity.spec.ts", import.meta.url), "utf8");
  const blockStarts = [...source.matchAll(/(^|\n)\s*test(?:\.beforeAll)?\s*\(/g)].map(
    (match) => match.index,
  );
  const triggers = [
    { name: "beforeAll memberGoingRsvp", index: source.indexOf("await memberGoingRsvp()") },
    {
      name: "isolatedRenewalCookie",
      index: source.indexOf("await isolatedRenewalCookie("),
    },
  ];
  assert.ok(
    triggers.every((trigger) => trigger.index >= 0),
    "a parity login trigger is gone — the guard would pass vacuously",
  );
  for (const trigger of triggers) {
    const blockStart = blockStarts.filter((start) => start < trigger.index).at(-1) ?? -1;
    const raised =
      source.lastIndexOf("qaLoginRetryBudgetMs(1)", trigger.index) > blockStart &&
      source.lastIndexOf("test.setTimeout(", trigger.index) > blockStart;
    assert.ok(
      raised,
      `parity.spec.ts: ${trigger.name} is not preceded in its block by ` +
        `test.setTimeout(<base> + qaLoginRetryBudgetMs(1)). Without that raise a 429 + ` +
        `Retry-After dies on the bare 30s timeout instead of completing the ` +
        `bounded retry.`,
    );
  }
});
