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
  QA_LOGIN_MAX_ATTEMPTS,
  QA_LOGIN_RETRY_AFTER_CAP_SECONDS,
} from "./qa-login-retry.mjs";
import { postParityQaLogin } from "./kit-parity/parity-qa-login.mjs";

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

// Kit parity QA-login retry: parity's shared (beforeAll) and
// isolated (renewal) logins share the job-wide qa-login window with the e2e
// suite's 10 logins, so a 429 there names the budget, not the verdict. The
// POST retries 429s only, honoring Retry-After, bounded by
// QA_LOGIN_MAX_ATTEMPTS; any other status passes through to the caller's own
// assertion. Stubbed transport below: no browser, no token.

const parityOk = () => ({
  status: () => 204,
  headers: () => ({}),
});

const parityThrottled = (retryAfter = "3") => ({
  status: () => 429,
  headers: () => ({ "retry-after": retryAfter }),
});

test("parity QA login honors one 429 then succeeds on the retry", async () => {
  let attempts = 0;
  const waits = [];
  const response = await postParityQaLogin(
    async () => {
      attempts++;
      return attempts === 1 ? parityThrottled("7") : parityOk();
    },
    { identity: "qa-member", wait: async (ms) => waits.push(ms) },
  );
  assert.equal(response.status(), 204);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [7_000]);
});

test("parity QA login falls back to the window when Retry-After is missing", async () => {
  let attempts = 0;
  const waits = [];
  const response = await postParityQaLogin(
    async () => {
      attempts++;
      return attempts === 1 ? { status: () => 429, headers: () => ({}) } : parityOk();
    },
    { identity: "qa-member", wait: async (ms) => waits.push(ms) },
  );
  assert.equal(response.status(), 204);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [60_000]);
});

test("parity QA login exhausts after the bounded throttled attempts", async () => {
  let attempts = 0;
  let waits = 0;
  await assert.rejects(
    postParityQaLogin(
      async () => {
        attempts++;
        return parityThrottled("1");
      },
      { identity: "qa-moderator", wait: async () => waits++ },
    ),
    (error) => {
      assert.match(error.message, /parity QA login as qa-moderator/);
      assert.match(error.message, /429/);
      assert.match(error.message, /10\/min/);
      assert.ok(!error.message.includes("X-TWO-QA-Auth"), "header name leaked");
      return true;
    },
  );
  assert.equal(attempts, QA_LOGIN_MAX_ATTEMPTS);
  assert.equal(waits, QA_LOGIN_MAX_ATTEMPTS - 1);
});

test("parity QA login never retries a non-429 verdict", async () => {
  for (const status of [204, 302, 401, 403, 404, 500]) {
    let attempts = 0;
    let waits = 0;
    const response = await postParityQaLogin(
      async () => {
        attempts++;
        return { status: () => status, headers: () => ({}) };
      },
      { identity: "qa-member", wait: async () => waits++ },
    );
    assert.equal(response.status(), status, `status ${status} must pass through`);
    assert.equal(attempts, 1, `status ${status} must not retry`);
    assert.equal(waits, 0, `status ${status} must not wait`);
  }
});

// Static guards, staging-guard style: the parity spec routes both logins
// through the bounded retry, keeps exactly-one logical counts and two logins,
// and raises the beforeAll hook timeout by the one-login retry budget.

const paritySpecUrl = new URL("./kit-parity/parity.spec.ts", import.meta.url);

test("parity routes both QA logins through the bounded 429 retry", () => {
  const source = readFileSync(paritySpecUrl, "utf8");
  assert.ok(
    source.includes('from "./parity-qa-login.mjs"'),
    "parity.spec.ts must import the parity QA-login retry helper",
  );
  const sharedFn = source.indexOf("function honoMemberCookie");
  const isolatedFn = source.indexOf("async function isolatedRenewalCookie");
  assert.ok(sharedFn >= 0 && isolatedFn > sharedFn, "both parity login helpers must exist");
  assert.ok(
    source.slice(sharedFn, isolatedFn).includes("postParityQaLogin"),
    "honoMemberCookie must POST through postParityQaLogin",
  );
  assert.ok(
    source.slice(isolatedFn).includes("postParityQaLogin"),
    "isolatedRenewalCookie must POST through postParityQaLogin",
  );
});

test("parity keeps exactly one logical login per helper and two logins total", () => {
  const source = readFileSync(paritySpecUrl, "utf8");
  assert.equal(
    source.match(/qaLoginCount \+= 1/g)?.length ?? 0,
    1,
    "qaLoginCount must increment once per shared-helper execution (outside the retry loop)",
  );
  assert.equal(
    source.match(/renewalLoginCount \+= 1/g)?.length ?? 0,
    1,
    "renewalLoginCount must increment once per isolated-helper execution (outside the retry loop)",
  );
  assert.equal(
    source.match(/\.post\("\/auth\/qa\//g)?.length ?? 0,
    2,
    "parity must keep exactly its two QA login POSTs (no new logins)",
  );
  assert.ok(
    source.includes('"exactly one shared QA login"'),
    "shared exactly-one assert must stay",
  );
  assert.ok(
    source.includes('"exactly one isolated renewal login"'),
    "isolated exactly-one assert must stay",
  );
});

test("parity beforeAll raises its hook timeout by the one-login retry budget", () => {
  const source = readFileSync(paritySpecUrl, "utf8");
  assert.ok(
    source.includes('from "../qa-login-retry.mjs"'),
    "parity.spec.ts must import the retry budget helper",
  );
  const hook = source.indexOf("test.beforeAll(");
  const login = source.indexOf("await memberGoingRsvp()");
  assert.ok(hook >= 0 && login > hook, "beforeAll must spend the shared login via memberGoingRsvp");
  assert.ok(
    source.lastIndexOf("qaLoginRetryBudgetMs(1)", login) > hook &&
      source.lastIndexOf("test.setTimeout(", login) > hook,
    "beforeAll must raise its own timeout first with " +
      "test.setTimeout(30_000 + qaLoginRetryBudgetMs(1)): one capped 65s wait dies " +
      "on the bare 30s hook timeout instead of completing the bounded retry.",
  );
});

test("parity isolated-login test raises its timeout by the one-login retry budget", () => {
  const source = readFileSync(paritySpecUrl, "utf8");
  assert.ok(
    source.includes('from "../qa-login-retry.mjs"'),
    "parity.spec.ts must import the retry budget helper",
  );
  const testStart = source.indexOf(
    'test("member renders the no-JS RSVP form posting to the Hono controller"',
  );
  const callSite = source.indexOf("await isolatedRenewalCookie(", testStart);
  assert.ok(
    testStart >= 0 && callSite > testStart,
    "isolated-login test must spend its login via isolatedRenewalCookie",
  );
  assert.ok(
    source.lastIndexOf("qaLoginRetryBudgetMs(1)", callSite) > testStart &&
      source.lastIndexOf("test.setTimeout(", callSite) > testStart,
    "isolated-login test must raise its own timeout first with " +
      "test.setTimeout(30_000 + qaLoginRetryBudgetMs(1)): one capped 65s wait dies " +
      "on the bare 30s test timeout instead of completing the bounded retry.",
  );
});
