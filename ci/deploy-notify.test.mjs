import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildPayload, deployOutcome, notify, signBody } from "./deploy-notify.mjs";

const SHA = "a".repeat(40);
const PROMOTED = "11111111-1111-4111-8111-111111111111";
const PREVIOUS = "22222222-2222-4222-8222-222222222222";
const NOW = () => new Date("2026-11-01T12:00:00Z");

const run = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "fixture/repo",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
};
const deployEnv = (overrides = {}) => ({
  ...run,
  NOTIFY_EVENT: "deploy",
  NOTIFY_SHA: SHA,
  NOTIFY_STARTED_AT: "2026-11-01T11:00:00Z",
  PROMOTED_VERSION_ID: PROMOTED,
  ROLLBACK_VERSION_ID: PREVIOUS,
  PREFLIGHT_RESULT: "success",
  SOAK_RESULT: "success",
  REGRESSION_RESULT: "success",
  DEPLOY_RESULT: "success",
  VERIFY_OUTCOME: "success",
  WATCH_RESULT: "success",
  WATCH_BREACH: "false",
  ROLLBACK_RESULT: "skipped",
  ...overrides,
});

test("a clean promotion reports success with its commit, versions and run", () => {
  assert.deepEqual(deployOutcome(deployEnv()), { outcome: "success", reason: null });
  assert.deepEqual(buildPayload(deployEnv(), { now: NOW }), {
    repo: "two-web-next",
    event: "deploy",
    outcome: "success",
    sha: SHA,
    versionId: PROMOTED,
    previousVersionId: PREVIOUS,
    runUrl: "https://github.com/fixture/repo/actions/runs/42/attempts/1",
    startedAt: "2026-11-01T11:00:00Z",
    finishedAt: "2026-11-01T12:00:00.000Z",
    reason: null,
  });
});

test("deploy outcomes name what fired", () => {
  const cases = [
    [
      {
        VERIFY_OUTCOME: "failure",
        DEPLOY_RESULT: "failure",
        WATCH_RESULT: "skipped",
        ROLLBACK_RESULT: "success",
      },
      "rolled_back",
      /smoke failed after 100%/,
    ],
    [
      { WATCH_RESULT: "failure", WATCH_BREACH: "true", ROLLBACK_RESULT: "success" },
      "rolled_back",
      /watch breach/,
    ],
    [
      { WATCH_RESULT: "failure", WATCH_BREACH: "true", ROLLBACK_RESULT: "failure" },
      "failed",
      /automatic rollback failed/,
    ],
    // A failed auto-rollback job whose mutation moved traffic completed the
    // restoration and failed verification: it must not claim the promoted
    // version may still serve.
    [
      {
        WATCH_RESULT: "failure",
        WATCH_BREACH: "true",
        ROLLBACK_RESULT: "failure",
        ROLLBACK_MUTATION: "success",
        ROLLBACK_SMOKE: "failure",
      },
      "failed",
      /restored the pre-promote version but post-rollback smoke failed/,
    ],
    // Same when the guard skipped the mutation because the target already
    // served and the smoke then failed: the restored version serves, so the
    // deploy record must say so. ROLLBACK_ACTION arrives from the
    // auto-rollback outputs on the deploy notify job.
    [
      {
        WATCH_RESULT: "failure",
        WATCH_BREACH: "true",
        ROLLBACK_RESULT: "failure",
        ROLLBACK_ACTION: "skip",
        ROLLBACK_MUTATION: "skipped",
        ROLLBACK_SMOKE: "failure",
      },
      "failed",
      /restored the pre-promote version but post-rollback smoke failed/,
    ],
    [{ PREFLIGHT_RESULT: "failure", DEPLOY_RESULT: "skipped" }, "failed", /preflight refused/],
    [{ REGRESSION_RESULT: "failure", DEPLOY_RESULT: "skipped" }, "failed", /regression check/],
    [
      { DEPLOY_RESULT: "failure", PROMOTED_VERSION_ID: "", VERIFY_OUTCOME: "skipped" },
      "failed",
      /before promotion; production unchanged/,
    ],
    [
      { DEPLOY_RESULT: "failure", VERIFY_OUTCOME: "skipped" },
      "failed",
      /gradual action's own rollback ran/,
    ],
    // A failure after the verified 100% promotion leaves the version live
    // with the watch skipped: it must not claim the gradual rollback ran.
    [
      { DEPLOY_RESULT: "failure", VERIFY_OUTCOME: "success", WATCH_RESULT: "skipped" },
      "failed",
      /live and unwatched/,
    ],
    // A superseded watch stood down without judging: clean but unwatched.
    [{ WATCH_VERDICT: "superseded" }, "success", /superseded by a newer deploy/],
    [
      { DEPLOY_RESULT: "cancelled", WATCH_RESULT: "skipped", ROLLBACK_RESULT: "skipped" },
      "failed",
      /deploy cancelled, watch skipped, rollback skipped/,
    ],
  ];
  for (const [overrides, outcome, reason] of cases) {
    const result = deployOutcome(deployEnv(overrides));
    assert.equal(result.outcome, outcome, JSON.stringify(overrides));
    assert.match(result.reason, reason, JSON.stringify(overrides));
  }
});

test("rollback events report the target and the version they replaced", () => {
  const env = {
    ...run,
    NOTIFY_EVENT: "rollback",
    ROLLBACK_VERSION_ID: PREVIOUS,
    EXPECTED_CURRENT_VERSION_ID: PROMOTED,
    ROLLBACK_RESULT: "success",
    ROLLBACK_ACTION: "rollback",
    ROLLBACK_REASON: "post-deploy watch breach (readiness or error rate)",
  };
  const payload = buildPayload(env, { now: NOW });
  assert.equal(payload.event, "rollback");
  assert.equal(payload.outcome, "success");
  assert.equal(payload.versionId, PREVIOUS);
  assert.equal(payload.previousVersionId, PROMOTED);
  assert.equal(payload.reason, "post-deploy watch breach (readiness or error rate)");
  const manual = buildPayload(
    { ...env, ROLLBACK_RESULT: "failure", ROLLBACK_REASON: "", EXPECTED_CURRENT_VERSION_ID: "" },
    { now: NOW },
  );
  assert.equal(manual.outcome, "failed");
  assert.equal(manual.previousVersionId, null);
  assert.match(
    manual.reason,
    /rollback did not complete \(rollback failure\); production may be unchanged/,
  );
  const manualSkipped = buildPayload(
    { ...env, ROLLBACK_RESULT: "skipped", ROLLBACK_REASON: "", EXPECTED_CURRENT_VERSION_ID: "" },
    { now: NOW },
  );
  assert.equal(manualSkipped.outcome, "failed");
  assert.match(
    manualSkipped.reason,
    /rollback did not complete \(rollback skipped\); production may be unchanged/,
  );
  // A failed job whose mutation moved traffic completed the restoration and
  // failed verification: the record must say the restored version serves,
  // not that traffic never moved.
  const restoredSmokeFailed = buildPayload(
    {
      ...env,
      ROLLBACK_RESULT: "failure",
      ROLLBACK_MUTATION: "success",
      ROLLBACK_SMOKE: "failure",
      ROLLBACK_REASON: "",
      EXPECTED_CURRENT_VERSION_ID: "",
    },
    { now: NOW },
  );
  assert.equal(restoredSmokeFailed.outcome, "failed");
  assert.match(
    restoredSmokeFailed.reason,
    /rollback completed but post-rollback smoke failed; production serves the restored version/,
  );
  // Same when the guard skipped the mutation because the target already
  // served and the smoke then failed.
  const alreadyServedSmokeFailed = buildPayload(
    {
      ...env,
      ROLLBACK_RESULT: "failure",
      ROLLBACK_ACTION: "skip",
      ROLLBACK_MUTATION: "skipped",
      ROLLBACK_SMOKE: "failure",
      ROLLBACK_REASON: "",
      EXPECTED_CURRENT_VERSION_ID: "",
    },
    { now: NOW },
  );
  assert.equal(alreadyServedSmokeFailed.outcome, "failed");
  assert.match(
    alreadyServedSmokeFailed.reason,
    /rollback completed but post-rollback smoke failed; production serves the restored version/,
  );
  assert.throws(() => buildPayload({ ...env, NOTIFY_EVENT: "push" }), /deploy or rollback/);
});

test("malformed identities are sent as null, never passed through", () => {
  const payload = buildPayload(
    deployEnv({ NOTIFY_SHA: "main", PROMOTED_VERSION_ID: "x;id", NOTIFY_STARTED_AT: "soon" }),
    { now: NOW },
  );
  assert.equal(payload.sha, null);
  assert.equal(payload.versionId, null);
  assert.equal(payload.startedAt, null);
});

test("the body is signed as HMAC-SHA256 over timestamp.body and sent once", async () => {
  const sent = [];
  const result = await notify(
    {
      ...deployEnv(),
      PAPERCLIP_DEPLOY_WEBHOOK_URL: "https://hooks.example/fire",
      PAPERCLIP_DEPLOY_WEBHOOK_SECRET: "fixture-secret",
    },
    {
      now: NOW,
      fetchImpl: async (url, init) => {
        sent.push({ url, init });
        return { ok: true, status: 202 };
      },
    },
  );
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  const [{ url, init }] = sent;
  assert.equal(url, "https://hooks.example/fire");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-paperclip-timestamp"], "1793534400");
  const expected = createHmac("sha256", "fixture-secret")
    .update(`1793534400.${init.body}`)
    .digest("hex");
  assert.equal(init.headers["x-paperclip-signature"], `sha256=${expected}`);
  assert.equal(signBody("fixture-secret", init.body, "1793534400"), `sha256=${expected}`);
  assert.equal(JSON.parse(init.body).outcome, "success");
  assert.ok(!init.body.includes("fixture-secret"));
});

test("an unconfigured webhook warns and sends nothing; a refused or non-https one fails", async () => {
  const none = await notify(deployEnv(), {
    fetchImpl: () => assert.fail("must not send without configuration"),
  });
  assert.equal(none.sent, false);
  const configured = {
    ...deployEnv(),
    PAPERCLIP_DEPLOY_WEBHOOK_URL: "https://hooks.example/fire",
    PAPERCLIP_DEPLOY_WEBHOOK_SECRET: "fixture-secret",
  };
  await assert.rejects(
    notify(configured, { fetchImpl: async () => ({ ok: false, status: 401 }) }),
    /answered HTTP 401/,
  );
  await assert.rejects(
    notify({ ...configured, PAPERCLIP_DEPLOY_WEBHOOK_URL: "http://hooks.example/fire" }),
    /must be https/,
  );
});

test("CLI never prints the secret", () => {
  const result = spawnSync(process.execPath, ["ci/deploy-notify.mjs"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...deployEnv(),
      PAPERCLIP_DEPLOY_WEBHOOK_URL: "http://hooks.example/fire",
      PAPERCLIP_DEPLOY_WEBHOOK_SECRET: "fixture-secret-canary",
    },
  });
  assert.equal(result.status, 1);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("fixture-secret-canary"));
  const unconfigured = spawnSync(process.execPath, ["ci/deploy-notify.mjs"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...deployEnv() },
  });
  assert.equal(unconfigured.status, 0);
  assert.match(unconfigured.stdout, /::warning::deploy-notify not sent/);
});

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("already-live preflight refusals notify while successful no-ops stay silent", () => {
  const workflow = read("../.github/workflows/deploy-production.yml");
  const job = workflow.slice(workflow.indexOf("\n  notify:\n"));
  const condition = job.match(/\n {4}if: \$\{\{ (.+) \}\}/)?.[1];
  assert.ok(condition, "notify has an explicit admission condition");
  for (const [sha, alreadyLive, result, expected] of [
    [SHA, "true", "failure", true],
    [SHA, "true", "cancelled", true],
    [SHA, "true", "success", false],
    [SHA, "false", "success", true],
    [SHA, "false", "failure", true],
    ["", "", "success", false],
    ["", "true", "failure", false],
    ["", "", "skipped", false],
  ]) {
    assert.equal(
      runInNewContext(condition, {
        always: () => true,
        needs: { preflight: { outputs: { sha, already_live: alreadyLive }, result } },
      }),
      expected,
      JSON.stringify({ sha, alreadyLive, result }),
    );
  }
  const payload = buildPayload(
    deployEnv({
      PREFLIGHT_RESULT: "failure",
      SOAK_RESULT: "skipped",
      REGRESSION_RESULT: "skipped",
      DEPLOY_RESULT: "skipped",
      PROMOTED_VERSION_ID: "",
      VERIFY_OUTCOME: "skipped",
      WATCH_RESULT: "skipped",
    }),
    { now: NOW },
  );
  assert.equal(payload.outcome, "failed");
  assert.equal(payload.sha, SHA);
  assert.equal(payload.versionId, null);
  assert.match(payload.reason, /preflight refused promotion/);
});

test("deploy and rollback workflows end with a non-blocking notify", () => {
  for (const [file, event, needs] of [
    [
      "deploy-production.yml",
      "deploy",
      "needs: [preflight, staging-soak, regression, deploy-production, post-deploy-watch, auto-rollback, release]",
    ],
    ["rollback-production.yml", "rollback", "needs: [preflight, rollback-production]"],
  ]) {
    const workflow = read(`../.github/workflows/${file}`);
    const at = workflow.indexOf("\n  notify:\n");
    assert.ok(at > 0, `${file} has a notify job`);
    const job = workflow.slice(at);
    assert.ok(!/\n  [\w-]+:\n/.test(job.slice(1)), `${file} notify is the last job`);
    const flat = (s) => s.replace(/\s+/g, "").replace(/,\]/g, "]");
    assert.ok(flat(job).includes(flat(needs)), `${file} notify needs ${needs}`);
    assert.match(job, /if: \$\{\{ always\(\) && /);
    assert.match(job, /continue-on-error: true\n {8}run: node ci\/deploy-notify\.mjs\n/);
    // Setup steps stay non-fatal: a checkout or Node setup failure after a
    // successful deploy or rollback must not fail the notify job.
    assert.match(job, /uses: actions\/checkout@[\da-f]+ # v[\d.]+\n {8}continue-on-error: true\n/);
    assert.match(
      job,
      /uses: actions\/setup-node@[\da-f]+ # v[\d.]+\n {8}continue-on-error: true\n/,
    );
    assert.match(job, new RegExp(`NOTIFY_EVENT: ${event}\\n`));
    if (event === "rollback") {
      assert.match(job, /NOTIFY_SHA: \$\{\{ inputs\.rollback_commit \}\}\n/);
    }
    if (event === "deploy") {
      assert.match(job, /WATCH_VERDICT: \$\{\{ needs\.post-deploy-watch\.outputs\.verdict \}\}/);
      assert.match(job, /ROLLBACK_ACTION: \$\{\{ needs\.auto-rollback\.outputs\.action \}\}/);
      assert.match(job, /ROLLBACK_MUTATION: \$\{\{ needs\.auto-rollback\.outputs\.mutation \}\}/);
      assert.match(job, /ROLLBACK_SMOKE: \$\{\{ needs\.auto-rollback\.outputs\.smoke \}\}/);
    }
    if (event === "rollback") {
      assert.match(job, /ROLLBACK_ACTION: \$\{\{ needs\.rollback-production\.outputs\.action \}\}/);
      assert.match(
        job,
        /ROLLBACK_MUTATION: \$\{\{ needs\.rollback-production\.outputs\.mutation \}\}/,
      );
      assert.match(job, /ROLLBACK_SMOKE: \$\{\{ needs\.rollback-production\.outputs\.smoke \}\}/);
    }
    assert.match(
      job,
      /PAPERCLIP_DEPLOY_WEBHOOK_URL: \$\{\{ vars\.PAPERCLIP_DEPLOY_WEBHOOK_URL \}\}/,
    );
    assert.match(
      job,
      /PAPERCLIP_DEPLOY_WEBHOOK_SECRET: \$\{\{ secrets\.PAPERCLIP_DEPLOY_WEBHOOK_SECRET \}\}/,
    );
    assert.ok(!/\n {4}environment:/.test(job), `${file} notify binds no Environment`);
    assert.ok(
      !/secrets\.(PRODUCTION_|CLOUDFLARE_)/.test(job),
      `${file} notify gets no deploy credentials`,
    );
  }
  // Staging drills never notify.
  assert.match(
    read("../.github/workflows/rollback-production.yml"),
    /inputs\.environment == 'production' \}\}/,
  );
  // The rollback mutation is recorded separately from the post-rollback
  // smoke so a failed job cannot misreport a completed restoration.
  const rollback = read("../.github/workflows/rollback-production.yml");
  assert.match(rollback, /id: rollback\n/);
  assert.match(rollback, /id: rollback-smoke\n/);
  assert.match(rollback, /mutation: \$\{\{ steps\.rollback\.outcome \}\}/);
  assert.match(rollback, /smoke: \$\{\{ steps\.rollback-smoke\.outcome \}\}/);
  assert.ok(
    rollback.includes("jobs.rollback-production.outputs.action"),
    "rollback workflow exposes the guard action",
  );
  assert.ok(
    rollback.includes("jobs.rollback-production.outputs.mutation"),
    "rollback workflow exposes the mutation outcome",
  );
  assert.ok(
    rollback.includes("jobs.rollback-production.outputs.smoke"),
    "rollback workflow exposes the smoke outcome",
  );
});
