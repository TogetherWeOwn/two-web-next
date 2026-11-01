import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readWranglerConfig } from "./wrangler-config.mjs";
import {
  AUTOMATIC_PROMOTION_EVENTS,
  PRODUCTION_HOLD_MAX_MS,
  PRODUCTION_ORIGIN,
  assertProductionCredentials,
  assertProductionHold,
  assertProductionProtection,
  assertProductionRequest,
  assertProductionTarget,
  assertRollbackVersionId,
  checkProductionGate,
  checkRollbackGate,
  isAlreadyLive,
  pendingLedgerTags,
  pendingMigrationTags,
  pendingProductionMigrations,
  readLedgerState,
  readLiveProductionCommit,
  readLiveProductionLedger,
  stagingQualityJob,
  stagingQualitySteps,
  targetWebEndUnknown,
  targetWebEntries,
} from "./production-deploy-gate.mjs";

const enabled = {
  PRODUCTION_DEPLOY_ENABLED: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "fixture/repo",
  GITHUB_TOKEN: "fixture-only",
  DEPLOY_SHA: "a".repeat(40),
};
const protectedEnvironment = {
  name: "production",
  protection_rules: [
    {
      type: "required_reviewers",
      prevent_self_review: true,
      reviewers: [{ type: "Team", reviewer: { id: 1 } }],
    },
  ],
};
const noNetwork = () => {
  assert.fail("disabled/invalid requests must not reach the API");
};

for (const flag of [undefined, "", "false", "TRUE", "1", " true", "true "]) {
  test(`refuses flag ${JSON.stringify(flag)} before API access`, async () => {
    await assert.rejects(
      checkProductionGate({ ...enabled, PRODUCTION_DEPLOY_ENABLED: flag }, noNetwork),
      /deployment disabled/,
    );
  });
}
for (const override of [
  { GITHUB_EVENT_NAME: "push" },
  { GITHUB_EVENT_NAME: "pull_request" },
  { GITHUB_REF: "refs/heads/feature" },
  { GITHUB_REF: "refs/tags/main" },
]) {
  test(`refuses non-manual/non-main request ${JSON.stringify(override)}`, async () => {
    await assert.rejects(
      checkProductionGate({ ...enabled, ...override }, noNetwork),
      /workflow_dispatch on main/,
    );
  });
}

test("CLI exits nonzero with an unset flag and no credentials", () => {
  const result = spawnSync(process.execPath, ["ci/production-deploy-gate.mjs"], {
    env: {
      PRODUCTION_DEPLOY_ENABLED: "",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deployment disabled/);
});

for (const status of [401, 403, 404, 500]) {
  test(`fails closed when Environment API returns ${status}`, async () => {
    await assert.rejects(
      checkProductionGate(enabled, async () => ({ ok: false, status })),
      new RegExp(`HTTP ${status}`),
    );
  });
}

test("fails closed when Environment API is unavailable", async () => {
  await assert.rejects(
    checkProductionGate(enabled, async () => {
      throw new Error("network unavailable");
    }),
    /network unavailable/,
  );
});

test("requires a production Environment with reviewers and no self-review", () => {
  for (const environment of [
    { name: "production", protection_rules: [] },
    { ...protectedEnvironment, name: "staging" },
    { name: "production", protection_rules: [{ type: "required_reviewers", reviewers: [] }] },
    {
      name: "production",
      protection_rules: [
        { type: "required_reviewers", reviewers: [{ type: "Team" }], prevent_self_review: false },
      ],
    },
  ]) {
    assert.throws(() => assertProductionProtection(environment), /required reviewers/);
  }
});

const dispatchSha = "a".repeat(40);
const otherSha = "b".repeat(40);
function ciEvidence() {
  const run = {
    id: 42,
    run_attempt: 1,
    head_sha: dispatchSha,
    head_branch: "main",
    event: "push",
    path: ".github/workflows/ci.yml",
    head_repository: { full_name: "fixture/repo" },
    status: "completed",
    conclusion: "success",
  };
  return {
    runs: { total_count: 1, workflow_runs: [structuredClone(run)] },
    jobs: {
      total_count: 2,
      jobs: ["a11y", "check"].map((name) => ({
        name,
        head_sha: dispatchSha,
        status: "completed",
        conclusion: "success",
      })),
    },
    current: structuredClone(run),
  };
}
function stubProductionApi(evidence, seen = {}) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/environments/production")) {
      seen.environment = (seen.environment ?? 0) + 1;
      return { ok: true, json: async () => protectedEnvironment };
    }
    seen.ci = (seen.ci ?? 0) + 1;
    if (parsed.pathname.endsWith("/workflows/ci.yml/runs")) {
      assert.equal(parsed.searchParams.get("head_sha"), dispatchSha);
      assert.equal(parsed.searchParams.get("branch"), "main");
      assert.equal(parsed.searchParams.get("event"), "push");
      return { ok: true, json: async () => evidence.runs };
    }
    if (parsed.pathname.endsWith("/runs/42/jobs")) {
      return { ok: true, json: async () => evidence.jobs };
    }
    if (parsed.pathname.endsWith("/runs/42")) {
      return { ok: true, json: async () => evidence.current };
    }
    assert.fail(`unexpected production gate API path ${parsed.pathname}`);
  };
}
const greenEnv = { ...enabled, GITHUB_SHA: otherSha, DEPLOY_SHA: dispatchSha };
function checkGreen(evidence, seen = {}, env = greenEnv, options = { checkoutSha: dispatchSha }) {
  return checkProductionGate(env, stubProductionApi(evidence, seen), options);
}

test("allows only an enabled main dispatch with verified protection and green exact-SHA CI", async () => {
  const seen = {};
  const evidence = await checkGreen(ciEvidence(), seen);
  assert.deepEqual(evidence, { sha: dispatchSha, runId: 42, runAttempt: 1 });
  assert.equal(seen.environment, 1);
  assert.equal(seen.ci, 3);
});

for (const [name, pattern, mutate] of [
  [
    "red CI",
    /Full CI has not completed successfully/,
    (evidence) => {
      evidence.runs.workflow_runs[0].conclusion = "failure";
    },
  ],
  [
    "pending CI",
    /Full CI has not completed successfully/,
    (evidence) => {
      evidence.runs.workflow_runs[0].status = "in_progress";
    },
  ],
  [
    "missing CI",
    /Missing or ambiguous exact-SHA CI evidence/,
    (evidence) => {
      evidence.runs = { total_count: 0, workflow_runs: [] };
    },
  ],
  [
    "ambiguous CI",
    /Missing or ambiguous exact-SHA CI evidence/,
    (evidence) => {
      evidence.runs.total_count = 2;
      evidence.runs.workflow_runs.push(structuredClone(evidence.runs.workflow_runs[0]));
    },
  ],
  [
    "missing check job",
    /Missing or ambiguous check job/,
    (evidence) => {
      evidence.jobs.jobs.pop();
      evidence.jobs.total_count = 1;
    },
  ],
  [
    "rerun between reads",
    /CI changed while checking evidence/,
    (evidence) => {
      evidence.current.run_attempt = 2;
    },
  ],
]) {
  test(`${name} refuses production deployment`, async () => {
    const evidence = ciEvidence();
    mutate(evidence);
    await assert.rejects(checkGreen(evidence), pattern);
  });
}

test("checkout/dispatch SHA mismatch refuses production deployment", async () => {
  await assert.rejects(
    checkGreen(ciEvidence(), {}, greenEnv, { checkoutSha: otherSha }),
    /Checkout does not match deployment SHA/,
  );
});

const sentinel = "00000000000000000000000000000000";
const provisionedId = "11111111111111111111111111111111";
const targetConfig = (hyperdrive) => JSON.stringify({ env: { production: { hyperdrive } } });

test("placeholder Hyperdrive refuses live deployment with fixture-only IDs", () => {
  assert.throws(
    () =>
      assertProductionTarget(
        targetConfig([
          { binding: "DB", id: sentinel },
          { binding: "BOT_DB", id: provisionedId },
        ]),
      ),
    /still a placeholder/,
  );
  assert.throws(
    () =>
      assertProductionTarget(
        targetConfig([
          { binding: "DB", id: provisionedId },
          { binding: "BOT_DB", id: sentinel },
        ]),
      ),
    /still a placeholder/,
  );
  assert.doesNotThrow(() =>
    assertProductionTarget(
      targetConfig([
        { binding: "DB", id: provisionedId },
        { binding: "BOT_DB", id: provisionedId },
      ]),
    ),
  );
});

for (const comment of ["/* inline comment */", "// line comment\n"]) {
  test(`JSONC comments cannot hide the production placeholder (${JSON.stringify(comment)})`, () => {
    const config = `{"env":{"production":{"hyperdrive":[{"binding":"DB","id":${comment}"${sentinel}",},],},},}`;
    assert.throws(() => assertProductionTarget(config), /still a placeholder/);
  });
}

test("provisioned production DB ignores historical comments, unrelated zero IDs and quoted strings", () => {
  const config = `{
    // Historical placeholder: "id": "${sentinel}"
    /* "id": "${sentinel}" */
    "hyperdrive": [{"binding":"DB","id":"${sentinel}"}],
    "vars": {"APP_URL":"https://fixture.example/path//kept", "NOTE":${JSON.stringify(`historical "id": "${sentinel}" /* kept */ ,}`)}},
    "env": {"production": {"hyperdrive": [
      {"binding":"OTHER","id":"${sentinel}"},
      {"binding":"DB","id":/* reviewed replacement */"${provisionedId}",},
      {"binding":"BOT_DB","id":"${provisionedId}",},
    ],},},
  }`;
  const parsed = readWranglerConfig(config);
  assert.equal(parsed.vars.APP_URL, "https://fixture.example/path//kept");
  assert.equal(parsed.vars.NOTE, `historical "id": "${sentinel}" /* kept */ ,}`);
  assert.doesNotThrow(() => assertProductionTarget(config));
});

for (const hyperdrive of [
  undefined,
  null,
  {},
  [],
  [{ binding: "OTHER", id: provisionedId }],
  [{ binding: "DB" }],
  [{ binding: "DB", id: null }],
  [{ binding: "DB", id: [provisionedId] }],
  [{ binding: "DB", id: "not-an-id" }],
  [{ binding: "DB", id: `${provisionedId}0` }],
  [{ binding: "DB", id: ` ${provisionedId}` }],
  [
    { binding: "DB", id: provisionedId },
    { binding: "DB", id: provisionedId },
  ],
]) {
  test(`refuses missing, invalid or duplicate production DB bindings (${JSON.stringify(hyperdrive)})`, () => {
    assert.throws(() => assertProductionTarget(targetConfig(hyperdrive)), /one valid id/);
  });
}

for (const botBinding of [
  undefined,
  null,
  {},
  [],
  [{ binding: "OTHER", id: provisionedId }],
  [{ binding: "BOT_DB" }],
  [{ binding: "BOT_DB", id: null }],
  [{ binding: "BOT_DB", id: [provisionedId] }],
  [{ binding: "BOT_DB", id: "not-an-id" }],
  [{ binding: "BOT_DB", id: `${provisionedId}0` }],
  [{ binding: "BOT_DB", id: ` ${provisionedId}` }],
  [
    { binding: "BOT_DB", id: provisionedId },
    { binding: "BOT_DB", id: provisionedId },
  ],
]) {
  test(`refuses missing, invalid or duplicate production BOT_DB bindings (${JSON.stringify(botBinding)})`, () => {
    const hyperdrive = [{ binding: "DB", id: provisionedId }];
    if (Array.isArray(botBinding)) hyperdrive.push(...botBinding);
    else if (botBinding !== undefined) hyperdrive.push(botBinding);
    // undefined botBinding leaves BOT_DB absent; other non-array shapes are
    // appended so the BOT_DB count/shape check fails instead of passing.
    assert.throws(() => assertProductionTarget(targetConfig(hyperdrive)), /BOT_DB.*one valid id/);
  });
}

for (const config of [
  "{}",
  '{"hyperdrive":[{"binding":"DB","id":"11111111111111111111111111111111"}]}',
  '{"env":{"staging":{"hyperdrive":[{"binding":"DB","id":"11111111111111111111111111111111"}]}}}',
]) {
  test(`refuses configs without an explicit production DB (${config})`, () => {
    assert.throws(() => assertProductionTarget(config), /one valid id/);
  });
}

for (const config of [
  '{"env":',
  "/* unterminated",
  `${targetConfig([{ binding: "DB", id: provisionedId }])} trailing`,
]) {
  test(`malformed JSONC fails closed (${config})`, () => {
    assert.throws(() => assertProductionTarget(config), SyntaxError);
  });
}

function assertIsolatedBindings(config, jobsConfig) {
  const production = config.env.production;
  assert.notEqual(production.name, config.name);
  assert.equal(production.workers_dev, false);
  assert.equal(production.preview_urls, false);
  assert.deepEqual(production.routes, [{ pattern: "togetherweown.com", custom_domain: true }]);
  assert.equal(production.vars.APP_URL, "https://togetherweown.com");
  assert.equal(production.vars.QA_AUTH_TOKEN, undefined);
  assert.notEqual(production.hyperdrive[0].id, config.hyperdrive[0].id);
  // Production handoff: the web production env only produces (no crons, no
  // consumers); both schedules and both consumers live on
  // two-web-jobs-production (wrangler.jobs.jsonc env.production), mirroring
  // the staging split. Values must match RECONCILE_CRON/PRUNE_CRON in
  // src/jobs/constants.ts.
  const jobsProduction = jobsConfig.env.production;
  assert.deepEqual(config.triggers, { crons: [] });
  assert.deepEqual(production.triggers, { crons: [] });
  assert.deepEqual(production.queues.consumers ?? [], []);
  assert.deepEqual(jobsProduction.triggers, { crons: ["*/10 * * * *", "0 0 * * *"] });
  const stagingQueues = config.queues.producers.map((producer) => producer.queue);
  for (const producer of production.queues.producers) {
    assert.ok(!stagingQueues.includes(producer.queue));
    assert.ok(
      jobsProduction.queues.consumers.some((consumer) => consumer.queue === producer.queue),
    );
  }
}

test("actual production config retains isolated bindings before and after sentinel replacement", () => {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = readWranglerConfig(text);
  const jobsText = readFileSync(new URL("../wrangler.jobs.jsonc", import.meta.url), "utf8");
  const jobsConfig = readWranglerConfig(jobsText);
  assertIsolatedBindings(config, jobsConfig);
  const provisioned = structuredClone(config);
  provisioned.env.production.hyperdrive[0].id = "11111111111111111111111111111111";
  assertIsolatedBindings(provisioned, jobsConfig);
  assert.doesNotThrow(() => assertProductionTarget(JSON.stringify(provisioned)));
});

function assertProductionHyperdrivePlaceholderCommentMatchesId(text) {
  const config = readWranglerConfig(text);
  const id = config.env?.production?.hyperdrive?.find((entry) => entry?.binding === "DB")?.id;
  assert.equal(typeof id, "string");

  const productionStart = text.search(/"production"\s*:\s*\{/);
  assert.ok(productionStart >= 0);
  const hyperdriveOffset = text.slice(productionStart).search(/"hyperdrive"\s*:/);
  assert.ok(hyperdriveOffset >= 0);
  const hyperdriveStart = productionStart + hyperdriveOffset;
  const lines = text.slice(productionStart, hyperdriveStart).trimEnd().split(/\r?\n/);
  const comments = [];
  while (lines.at(-1)?.trimStart().startsWith("//")) {
    comments.unshift(lines.pop().trim());
  }
  const resourceCommentIndex = comments.findIndex(
    (line) => /hyperdrive/i.test(line) && /two-web-next-production/i.test(line),
  );
  assert.ok(resourceCommentIndex >= 0, "production Hyperdrive comment must identify its resource");
  const productionHyperdriveComment = comments.slice(resourceCommentIndex).join(" ");
  const placeholderHyperdriveComment = /placeholder/i.test(productionHyperdriveComment);
  assert.equal(
    placeholderHyperdriveComment,
    id === sentinel,
    id === sentinel
      ? "the production sentinel comment must identify the placeholder Hyperdrive"
      : "a provisioned production Hyperdrive comment must not call its id a placeholder",
  );
}

test("checked-in production Hyperdrive uses placeholder wording only for the sentinel id", () => {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assertProductionHyperdrivePlaceholderCommentMatchesId(text);

  for (const unrelated of [
    "// PLACEHOLDER: unrelated queue setting",
    "// PLACEHOLDER: hyperdrive timeout tuning for queues",
    "// PLACEHOLDER: production hyperdrive timeout tuning for queues",
  ]) {
    const withUnrelatedPlaceholder = text.replace(
      "// Production Hyperdrive for the separately named two-web-next-production",
      `${unrelated}\n      // Production Hyperdrive for the separately named two-web-next-production`,
    );
    assertProductionHyperdrivePlaceholderCommentMatchesId(withUnrelatedPlaceholder);
  }

  const reformattedKeys = text
    .replace('"production": {', '"production" : {')
    .replace('"hyperdrive":', '"hyperdrive" :')
    .replace('"id": "', '"id" : "');
  assertProductionHyperdrivePlaceholderCommentMatchesId(reformattedKeys);

  const productionStart = text.search(/"production"\s*:\s*\{/);
  const hyperdriveOffset = text.slice(productionStart).search(/"hyperdrive"\s*:/);
  const hyperdriveStart = productionStart + hyperdriveOffset;
  const idMatch = /"id"\s*:\s*"/.exec(text.slice(hyperdriveStart));
  assert.ok(idMatch);
  const idStart = hyperdriveStart + idMatch.index + idMatch[0].length;
  const idEnd = text.indexOf('"', idStart);
  const sentinelWithProvisionedComment = `${text.slice(0, idStart)}${sentinel}${text.slice(idEnd)}`;
  assert.throws(
    () => assertProductionHyperdrivePlaceholderCommentMatchesId(sentinelWithProvisionedComment),
    /production sentinel comment must identify the placeholder Hyperdrive/,
  );

  const placeholderOnProvisionedId = text.replace(
    "// Production Hyperdrive for the separately named two-web-next-production",
    "// PLACEHOLDER: replace with the separately provisioned two-web-next-production Hyperdrive",
  );
  assert.throws(
    () => assertProductionHyperdrivePlaceholderCommentMatchesId(placeholderOnProvisionedId),
    /provisioned production Hyperdrive comment must not call its id a placeholder/,
  );
});

test("preserves the owner exception for admin bypass without relaxing self-review protection", () => {
  for (const can_admins_bypass of [true, false]) {
    const environment = { ...protectedEnvironment, can_admins_bypass };
    assert.doesNotThrow(() => assertProductionProtection(environment));
    assert.throws(
      () =>
        assertProductionProtection({
          ...environment,
          protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: false }],
        }),
      /required reviewers/,
    );
  }
});

const credentials = {
  CLOUDFLARE_API_TOKEN: "fixture-only",
  CLOUDFLARE_ACCOUNT_ID: "fixture-account",
};
for (const key of Object.keys(credentials)) {
  for (const value of [undefined, "", "   "]) {
    test(`refuses missing/empty production credential ${key}=${JSON.stringify(value)}`, () => {
      assert.throws(
        () => assertProductionCredentials({ ...credentials, [key]: value }),
        /Production-only Cloudflare credentials/,
      );
    });
  }
}

for (const value of [
  undefined,
  "",
  "   ",
  "not-a-version",
  "12345678-1234-1234-1234-123456789abc\n",
  " 12345678-1234-1234-1234-123456789abc",
  "12345678-1234-1234-1234-123456789abc ",
  "12345678_1234_1234_1234_123456789abc",
  "12345678123412341234123456789abc",
  "{12345678-1234-1234-1234-123456789abc}",
  "ABCDEF12-1234-1234-1234-123456789ABC",
  // Shell metacharacters must never reach the rollback command as an argument.
  "12345678-1234-1234-1234-123456789abc; printf HARMLESS",
  "$(printf HARMLESS)",
  "`printf HARMLESS`",
  "12345678-1234-1234-1234-123456789abc || true",
  "12345678-1234-1234-1234-123456789abc$HOME",
  "12345678-1234-1234-1234-123456789abc*",
]) {
  test(`refuses rollback version_id ${JSON.stringify(value)}`, () => {
    assert.throws(() => assertRollbackVersionId(value), /Rollback version_id/);
  });
}

test("accepts only a lowercase Worker Version UUID", () => {
  assert.doesNotThrow(() => assertRollbackVersionId("12345678-1234-1234-1234-123456789abc"));
});

test("version-id CLI fails closed without network access and never echoes the value", () => {
  const hostile = "12345678-1234-1234-1234-123456789abc; printf CREDENTIAL_MARKER";
  const rejected = spawnSync(process.execPath, ["ci/production-deploy-gate.mjs", "--version-id"], {
    env: { ROLLBACK_VERSION_ID: hostile },
    encoding: "utf8",
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Rollback version_id/);
  assert.ok(!rejected.stdout.includes("CREDENTIAL_MARKER"));
  assert.ok(!rejected.stderr.includes("CREDENTIAL_MARKER"));
  const accepted = spawnSync(process.execPath, ["ci/production-deploy-gate.mjs", "--version-id"], {
    env: { ROLLBACK_VERSION_ID: "12345678-1234-1234-1234-123456789abc" },
    encoding: "utf8",
  });
  assert.equal(accepted.status, 0);
});

test("credential CLI fails closed without printing credentials or accessing the API", () => {
  const missing = spawnSync(process.execPath, ["ci/production-deploy-gate.mjs", "--credentials"], {
    env: { CLOUDFLARE_API_TOKEN: credentials.CLOUDFLARE_API_TOKEN },
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Production-only Cloudflare credentials/);
  assert.ok(!missing.stderr.includes(credentials.CLOUDFLARE_API_TOKEN));
  const present = spawnSync(process.execPath, ["ci/production-deploy-gate.mjs", "--credentials"], {
    env: credentials,
    encoding: "utf8",
  });
  assert.equal(present.status, 0);
  assert.ok(!present.stdout.includes(credentials.CLOUDFLARE_API_TOKEN));
  assert.ok(!present.stdout.includes(credentials.CLOUDFLARE_ACCOUNT_ID));
});

test("help CLI prints usage without running the gate or touching GITHUB_OUTPUT", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-help-"));
  const output = join(dir, "github-output");
  const result = spawnSync(process.execPath, ["ci/production-deploy-gate.mjs", "--help"], {
    env: { GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node ci\/production-deploy-gate\.mjs/);
  for (const flag of ["--credentials", "--version-id", "--already-live", "--check-migrations"]) {
    assert.ok(result.stdout.includes(flag), flag);
  }
  assert.equal(result.stderr, "");
  assert.ok(!existsSync(output));
});

for (const flag of ["--bogus", "--check-migration"]) {
  test(`unknown flag ${flag} refuses with usage instead of running the gate`, () => {
    const result = spawnSync(process.execPath, ["ci/production-deploy-gate.mjs", flag], {
      env: {},
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: node ci\/production-deploy-gate\.mjs/);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("::error::"));
    assert.ok(!result.stderr.match(/deployment disabled/));
  });
}

test("both Environment gate jobs inherit contents and Actions read permissions", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^permissions:\n  contents: read\n  actions: read\n/m);
  // The post-deploy `release` call (release.yml) is the only job override: it
  // needs only Actions read for promotion proof and contents write to tag/release.
  const release = workflow.slice(workflow.indexOf("\n  release:\n"));
  const releaseLines = release
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trimEnd())
    .filter((line) => line.trim());
  const permissionsAt = releaseLines.indexOf("    permissions:");
  assert.notEqual(permissionsAt, -1, "release caller must declare its permissions");
  const permissions = releaseLines.slice(permissionsAt + 1);
  const nextField = permissions.findIndex((line) => /^ {0,4}\S/.test(line));
  assert.deepEqual(
    permissions
      .slice(0, nextField === -1 ? undefined : nextField)
      .map((line) => line.trim())
      .sort(),
    ["actions: read", "contents: write"],
    "release caller must grant exactly Actions read and contents write",
  );
  assert.ok(
    !/^ {4,}permissions:/m.test(workflow.slice(0, workflow.indexOf("\n  release:\n"))),
    "job overrides must not drop inherited Actions read",
  );
  assert.match(workflow, /^  preflight:/m);
  assert.match(workflow, /^  deploy-production:/m);
  assert.equal((workflow.match(/run: node ci\/production-deploy-gate\.mjs\n/g) ?? []).length, 2);
  const gates = workflow.split("run: node ci/production-deploy-gate.mjs\n").slice(1);
  assert.equal(gates.length, 2);
  for (const gate of gates) {
    const block = gate.split("\n      - ")[0];
    assert.match(block, /GITHUB_TOKEN: /);
    // The runner resets step-level GITHUB_* overrides to github.sha, so the
    // promoted commit must travel under a non-reserved name.
    assert.match(block, /DEPLOY_SHA: \$\{\{ (steps\.target|needs\.preflight)\.outputs\.sha \}\}/);
    assert.doesNotMatch(block, /GITHUB_SHA: /);
  }
});

test("preflight checkouts materialize ci and wrangler.jsonc for the production gate", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  // The gate's main path reads the repo-root Wrangler config, so the sparse
  // preflight tree must contain it (ci/production-deploy-gate.mjs:260).
  const gate = readFileSync(new URL("./production-deploy-gate.mjs", import.meta.url), "utf8");
  assert.match(gate, /\.\.\/wrangler\.jsonc/);
  // Negative control: the promotion resolver needs only ci/ files, so it
  // succeeds on the same sparse tree — it proves the checkout works and the
  // gate is the step that needs the extra root file.
  const resolver = readFileSync(new URL("./resolve-promotion-sha.mjs", import.meta.url), "utf8");
  assert.ok(!resolver.includes("wrangler"), "resolver must not need wrangler.jsonc");
  assert.ok(!resolver.includes("../"), "resolver must not read outside ci/");
  // Hardening: every checkout in preflight runs at the same workspace path,
  // so each one lists both /ci/ and /wrangler.jsonc explicitly (cone-mode
  // off so the file pattern applies). Cone-mode `ci` already includes root
  // files and an empty sparse-checkout input disables sparse checkout in
  // actions/checkout v7, so this guards against future cone-default or
  // checkout-behavior changes, not an observed ENOENT.
  const preflight = workflow.slice(
    workflow.indexOf("\n  preflight:\n"),
    workflow.indexOf("\n  staging-soak:\n"),
  );
  assert.ok(preflight.includes("preflight"), "preflight job missing");
  const checkouts = preflight.split("- uses: actions/checkout@").slice(1);
  assert.ok(checkouts.length >= 2, `expected >=2 preflight checkouts, found ${checkouts.length}`);
  for (const block of checkouts) {
    const step = block.split("\n      - ")[0];
    assert.match(step, /sparse-checkout:/, "preflight checkout must set sparse-checkout");
    assert.match(
      step,
      /sparse-checkout-cone-mode: false/,
      "preflight checkout must disable cone mode so the wrangler.jsonc file pattern applies",
    );
    assert.match(step, /\/ci\//, "preflight sparse scope must include anchored /ci/");
    assert.match(
      step,
      /\/wrangler\.jsonc/,
      "preflight sparse scope must include anchored /wrangler.jsonc",
    );
  }
});

test("manual production workflow routes runners by repo visibility and uses production-only secrets", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  // Self-hosted while private; GitHub-hosted only while public (TOG-12326).
  const runsOn = `runs-on: \${{ github.event.repository.private && fromJSON('["self-hosted","two-selfhosted"]') || 'ubuntu-latest' }}\n`;
  // preflight, staging-soak, regression, deploy-production and
  // post-deploy-watch.
  assert.equal(workflow.split(runsOn).length - 1, 5);
  assert.equal(
    workflow.split("ubuntu-latest").length - 1,
    5,
    "ubuntu-latest only as the public-repo branch",
  );
  // Staging credentials appear only in the read-only staging-soak job: no
  // Environment, no wrangler, one gate call.
  const soak = workflow.slice(
    workflow.indexOf("\n  staging-soak:\n"),
    workflow.indexOf("\n  regression:\n"),
  );
  const outsideSoak = workflow.replace(soak, "");
  assert.ok(!outsideSoak.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(!outsideSoak.includes("secrets.CLOUDFLARE_ACCOUNT_ID"));
  assert.equal(soak.split("secrets.CLOUDFLARE_API_TOKEN").length - 1, 1);
  assert.ok(!/\n {4}environment:/.test(soak), "staging-soak binds no Environment");
  assert.ok(!soak.includes("wrangler "), "staging-soak never runs wrangler");
  assert.ok(!/secrets\.PRODUCTION_/.test(soak), "staging-soak never sees production secrets");
  assert.match(soak, /run: node ci\/production-deploy-gate\.mjs --staging-soak\n/);
  for (const key of Object.keys(credentials)) {
    // Credentials check, required-secrets preflight, rollback-target check,
    // production Tail deploy, version upload, promotion, the regression
    // check and the post-deploy watch: all production-only.
    assert.equal((workflow.match(new RegExp(`secrets\\.PRODUCTION_${key}`, "g")) ?? []).length, 8);
  }
  const credentialCheck = workflow.indexOf("run: node ci/production-deploy-gate.mjs --credentials");
  const requiredSecrets = workflow.indexOf("run: node ci/check-production-secrets.mjs");
  const rollbackTarget = workflow.indexOf(
    "- name: Confirm the recorded rollback target still exists with its secrets",
  );
  const tailDeploy = workflow.indexOf(
    "run: npx wrangler deploy --config tail/wrangler.jsonc --env production",
  );
  const upload = workflow.indexOf("npx wrangler versions upload --env production --tag ");
  const gradual = workflow.indexOf(
    "uses: TogetherWeOwn/.github/actions/gradual-promote@89c290be20c0044efaf6916f28341c76e75fff06",
  );
  assert.ok(
    credentialCheck > 0 &&
      credentialCheck < requiredSecrets &&
      requiredSecrets < rollbackTarget &&
      rollbackTarget < tailDeploy &&
      tailDeploy < upload &&
      upload < gradual,
  );
  assert.match(
    workflow,
    /versions upload --env production --tag "\$\{DEPLOY_SHA:\?\}-\$\{GITHUB_RUN_ID:\?\}-\$\{GITHUB_RUN_ATTEMPT:\?\}"/,
  );
  // Promotion lives in the shared composite action: the caller only passes
  // the tag built from the exact same three parts as the upload tag above.
  const call = workflow.slice(gradual, gradual + 800);
  assert.match(call, /worker-name: two-web-next-production/);
  assert.match(
    call,
    /version-tag: \$\{\{ needs\.preflight\.outputs\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(call, /domain: togetherweown\.com/);
  assert.match(call, /api-token: \$\{\{ secrets\.PRODUCTION_CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(call, /account-id: \$\{\{ secrets\.PRODUCTION_CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.ok(!workflow.includes("npx wrangler versions deploy --env production"));
  assert.ok(!workflow.includes("wrangler deploy --env production"));
});

test("shared gradual action promotes 5-50-100 with per-stage gates and auto-rollback", () => {
  const action = readFileSync(
    new URL("../.github/actions/gradual-promote/action.yml", import.meta.url),
    "utf8",
  );
  // Ladder order: record rollback target, resolve the new id, then each
  // stage deploys, gates, and rolls back before the next stage starts.
  const order = [
    "Record pre-promote rollback target",
    "Resolve promoted version id",
    "Promote to 5 percent",
    "Health and SLO gate at 5 percent",
    "Automatic rollback after 5 percent gate failure",
    "Promote to 50 percent",
    "Health and SLO gate at 50 percent",
    "Automatic rollback after 50 percent gate failure",
    "Promote to 100 percent",
    "Health and SLO gate at 100 percent (new version)",
    "Health and SLO gate at 100 percent (live traffic)",
    "Automatic rollback after 100 percent gate failure",
  ];
  let at = -1;
  for (const name of order) {
    const next = action.indexOf(`- name: ${name}\n`);
    assert.ok(next > at, `stage out of order or missing: ${name}`);
    at = next;
  }
  // Deterministic specs from code, never interpolated percentages: wrangler
  // refuses a lone TAG@5% (traffic must total 100), so each gradual step
  // names the pre-promote version alongside the new tag.
  assert.equal(
    (action.match(/--deploy-spec "\$VERSION_TAG" (5|50|100) "\$PREV_VERSION"/g) ?? []).length,
    3,
  );
  assert.ok(action.includes("npx wrangler versions deploy --env production"));
  assert.ok(action.includes('npx wrangler rollback "$PREV_VERSION"'));
  // Every rollback runs on any failure or cancellation once a rollback target
  // is recorded: promote API errors and step timeouts included, not just
  // gate failures. Later rollbacks stand down only when an earlier one
  // recorded success (outputs.restored == 'true'); a failed restore leaves
  // the output empty so the next rollback retries (up to three attempts for
  // free). Each restore is time-bounded and refuses an unknown target before
  // wrangler ever runs.
  assert.equal(
    (
      action.match(
        /if: \(failure\(\) \|\| cancelled\(\)\) && steps\.rollback-target\.conclusion == 'success'/g,
      ) ?? []
    ).length,
    3,
  );
  // Success is recorded explicitly after each restore; a wrangler failure
  // under `set -euo pipefail` exits before the echo, leaving no output.
  assert.equal((action.match(/echo "restored=true" >> "\$GITHUB_OUTPUT"/g) ?? []).length, 3);
  assert.ok(action.includes("&& steps.rollback-5.outputs.restored != 'true'"));
  assert.ok(action.includes("&& steps.rollback-50.outputs.restored != 'true'"));
  // A failed rollback must never count as restored: conclusion-based
  // stand-down guards would treat failure as done.
  assert.ok(!action.includes("rollback-5.conclusion == 'skipped'"));
  assert.ok(!action.includes("rollback-50.conclusion == 'skipped'"));
  assert.equal((action.match(/timeout 120 npx wrangler rollback/g) ?? []).length, 3);
  assert.equal(
    (action.match(/: "\$\{PREV_VERSION:\?missing pre-promote rollback target\}"/g) ?? []).length,
    3,
  );
  // Four smoke loops exit 0 on success and exit 1 when retries run out;
  // three rollback steps exit 1 after restoring the pre-promote version.
  assert.equal((action.match(/^            exit 0$/gm) ?? []).length, 4);
  assert.equal((action.match(/^        exit 1$/gm) ?? []).length, 7);
  // Canary stages probe the new version directly; the final stage also probes
  // live traffic. No curl one-offs, no trigger or full deploys.
  // The override pins probes to the new version in the checker's quoted
  // worker="uuid" shape; the checker rejects an unquoted value before any
  // probe, so an unquoted shell would fail every canary gate into rollback.
  assert.equal(
    (action.match(/--version-override "\$WORKER_NAME=\\"\$NEW_VERSION\\""/g) ?? []).length,
    3,
  );
  assert.ok(!action.includes("curl "));
  assert.ok(!action.includes("wrangler triggers deploy"));
  assert.ok(!action.includes("wrangler deploy --env production"));
});

test("rollback stand-down retries promote failures, cancellations and failed restores", () => {
  const action = readFileSync(
    new URL("../.github/actions/gradual-promote/action.yml", import.meta.url),
    "utf8",
  );
  const guard50 = action.match(
    /- name: Automatic rollback after 50 percent gate failure\n(?:.*\n)*? {6}if: (.*)\n/,
  )?.[1];
  const guard100 = action.match(
    /- name: Automatic rollback after 100 percent gate failure\n(?:.*\n)*? {6}if: (.*)\n/,
  )?.[1];
  assert.ok(guard50, "rollback-50 has an if: guard");
  assert.ok(guard100, "rollback-100 has an if: guard");
  // Both guards run on failure or cancellation with a recorded target.
  for (const guard of [guard50, guard100]) {
    assert.match(guard, /\(failure\(\) \|\| cancelled\(\)\)/);
    assert.match(guard, /steps\.rollback-target\.conclusion == 'success'/);
  }
  // Stand-down is success-explicit: only outputs.restored == 'true' holds the
  // next rollback back. Empty means skipped (earlier stage never ran) or a
  // failed/cancelled restore that never reached the echo.
  const wouldRun50 = (restored5) => restored5 !== "true";
  const wouldRun100 = (restored5, restored50) => restored5 !== "true" && restored50 !== "true";
  assert.ok(guard50.includes("steps.rollback-5.outputs.restored != 'true'"));
  assert.ok(guard100.includes("steps.rollback-5.outputs.restored != 'true'"));
  assert.ok(guard100.includes("steps.rollback-50.outputs.restored != 'true'"));
  const cases = [
    // [label, restored5, restored50, run50, run100]
    // A failed or cancelled restore never reaches the echo, so its output is
    // empty — exactly like a skipped step — and the next rollback retries.
    ["promote failure before any rollback", "", "", true, true],
    ["cancelled before any rollback", undefined, undefined, true, true],
    ["failed 5 percent restore leaves no output so 50 retries", "", "", true, true],
    ["successful 5 percent restore stands down later steps", "true", "", false, false],
    ["successful 50 percent restore stands down the last step", "", "true", true, false],
    ["both restores recorded stand down everything", "true", "true", false, false],
  ];
  for (const [label, restored5, restored50, run50, run100] of cases) {
    assert.equal(wouldRun50(restored5 ?? ""), run50, label);
    assert.equal(wouldRun100(restored5 ?? "", restored50 ?? ""), run100, label);
  }
});

test("rollback workflow reuses the production gate with no wider permissions", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8",
  );
  // Manual dispatch or a call from automation: no push, PR, release or
  // completion trigger of its own.
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.match(workflow, /\n  workflow_call:\n/);
  assert.ok(!workflow.includes("push:"));
  assert.ok(!workflow.includes("pull_request:"));
  assert.ok(!workflow.includes("workflow_run:"));
  assert.match(workflow, /^permissions:\n  contents: read\n  actions: read\n/m);
  assert.ok(
    !/^ {4,}permissions:/m.test(workflow),
    "job overrides must not drop inherited Actions read",
  );
  assert.match(workflow, /^  preflight:/m);
  assert.match(workflow, /^  rollback-production:/m);
  // The chosen Environment gate (production in either approval mode, or
  // staging); never cancelled. Preflight validates the name before the job
  // binds it, so a typo cannot auto-create an unprotected Environment.
  assert.match(workflow, /environment:\n      name: \$\{\{ inputs\.environment \}\}\n/);
  assert.match(workflow, /options: \[production, staging\]/);
  assert.match(workflow, /cancel-in-progress: false/);
  const preflightJob = workflow.slice(
    workflow.indexOf("\n  preflight:\n"),
    workflow.indexOf("\n  rollback-production:\n"),
  );
  assert.ok(
    preflightJob.indexOf("run: node ci/rollback-target.mjs --environment") <
      preflightJob.indexOf("run: node ci/production-deploy-gate.mjs --rollback"),
  );
  // Same rollback request gate in both jobs.
  assert.equal(
    (workflow.match(/run: node ci\/production-deploy-gate\.mjs --rollback\n/g) ?? []).length,
    2,
  );
  // version_id validation runs before the rollback command, in both jobs.
  assert.equal(
    (workflow.match(/run: node ci\/production-deploy-gate\.mjs --version-id\n/g) ?? []).length,
    2,
  );
  // Same visibility-aware runners as the production deploy workflow (TOG-12326).
  const runsOn = `runs-on: \${{ github.event.repository.private && fromJSON('["self-hosted","two-selfhosted"]') || 'ubuntu-latest' }}\n`;
  assert.equal(workflow.split(runsOn).length - 1, 2);
  assert.equal(
    workflow.split("ubuntu-latest").length - 1,
    2,
    "ubuntu-latest only as the public-repo branch",
  );
  // Each environment gets only its own credentials: production secrets only
  // when the environment is exactly production, staging (repo-level)
  // secrets only when it is exactly staging. Credential check before the
  // mutation.
  for (const key of Object.keys(credentials)) {
    // Credentials check, live-version guard, rollback target-version secrets
    // preflight and the rollback itself.
    const selector = `\${{ inputs.environment == 'production' && secrets.PRODUCTION_${key} || inputs.environment == 'staging' && secrets.${key} || '' }}`;
    assert.equal(workflow.split(selector).length - 1, 4);
    assert.equal((workflow.match(new RegExp(`secrets\\.PRODUCTION_${key}`, "g")) ?? []).length, 4);
    assert.equal((workflow.match(new RegExp(`secrets\\.${key}\\b`, "g")) ?? []).length, 4);
  }
  const versionCheck = workflow.indexOf("run: node ci/production-deploy-gate.mjs --version-id");
  const credentialCheck = workflow.indexOf("run: node ci/production-deploy-gate.mjs --credentials");
  const targetSecrets = workflow.indexOf(
    "run: node ci/check-production-secrets.mjs --rollback-version",
  );
  const rollback = workflow.indexOf(
    'run: npx wrangler rollback "$ROLLBACK_VERSION_ID" --name "$ROLLBACK_WORKER_NAME"',
  );
  assert.match(workflow, /ROLLBACK_WORKER_NAME: \$\{\{ steps\.target\.outputs\.worker \}\}/);
  assert.ok(rollback > 0);
  assert.ok(
    versionCheck > 0 &&
      versionCheck < credentialCheck &&
      credentialCheck < targetSecrets &&
      targetSecrets < rollback,
  );
  // The rollback deploys the recorded version's own bindings: moderator and
  // dry-run checks validate the dispatch SHA and must never gate it, and the
  // secrets check must read the target version, never the latest listing.
  assert.ok(
    !workflow.includes("run: npm run check:worker-moderators-production"),
    "rollback must not gate on the dispatch SHA moderator config",
  );
  assert.ok(
    !workflow.includes("npx wrangler deploy --dry-run --env production"),
    "rollback must not gate on a dispatch SHA dry-run build",
  );
  for (const line of workflow.split("\n")) {
    if (line.includes("ci/check-production-secrets.mjs")) {
      assert.ok(
        line.includes("--rollback-version"),
        `rollback must only check the target version: ${line.trim()}`,
      );
    }
  }
  // The input never interpolates into a run: block; it travels inputs -> env.
  for (const line of workflow.split("\n")) {
    if (line.trimStart().startsWith("run:") && line.includes("inputs.version_id")) {
      assert.fail(`input interpolates into a run: block: ${line}`);
    }
  }
  assert.match(workflow, /ROLLBACK_VERSION_ID: \$\{\{ inputs\.version_id \}\}/);
});

const sharedMutationGroup = "production-worker-mutation";

function jobConcurrencyBlocks(workflow) {
  return [
    ...workflow.matchAll(
      /^    concurrency:\n      group: (.+)\n      cancel-in-progress: (true|false)\n/gm,
    ),
  ].map((match) => ({ group: match[1].trim(), cancel: match[2] }));
}

test("production promotion and rollback mutations share one static non-cancelling lock", () => {
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const rollback = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8",
  );
  // The rollback lock is chosen per environment from two static names:
  // production shares the promotion lock, staging shares deploy.yml's.
  const rollbackSelector =
    "${{ inputs.environment == 'staging' && 'deploy-staging' || 'production-worker-mutation' }}";
  assert.deepEqual(
    jobConcurrencyBlocks(rollback).map((block) => block.group),
    [rollbackSelector],
  );
  const production = rollback.replace(rollbackSelector, sharedMutationGroup);
  const staging = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.deepEqual(
    jobConcurrencyBlocks(staging).map((block) => block.group),
    ["deploy-staging"],
    "the staging rollback lock must match deploy.yml's job-level lock",
  );
  for (const [label, workflow] of [
    ["deploy-production.yml", deploy],
    ["rollback-production.yml (production)", production],
  ]) {
    const blocks = jobConcurrencyBlocks(workflow);
    // Exactly one job-level mutation lock per workflow: deleting it fails here.
    assert.equal(blocks.length, 1, `${label} must hold exactly one job-level mutation lock`);
    assert.equal(blocks[0].group, sharedMutationGroup, `${label} mutation lock diverged`);
    // A cancelling lock would let a queued run kill the active Worker mutation.
    assert.equal(blocks[0].cancel, "false", `${label} mutation lock must not cancel`);
    // The lock is independent of run/ref: no expression and no run-specific suffix.
    assert.ok(!blocks[0].group.includes("${{"), `${label} mutation lock must be static`);
    for (const suffix of ["github.", "run_id", "run_number", "run_attempt", "ref", "sha"]) {
      assert.ok(
        !blocks[0].group.toLowerCase().includes(suffix),
        `${label} mutation lock must not carry a run-specific suffix (${suffix})`,
      );
    }
  }
  const deployGroup = jobConcurrencyBlocks(deploy)[0].group;
  const rollbackGroup = jobConcurrencyBlocks(production)[0].group;
  assert.equal(deployGroup, rollbackGroup, "promotion and rollback locks must match exactly");
});

test("shared production mutation lock never nests at workflow level nor leaks into release", () => {
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const rollback = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8",
  );
  // Workflow-level groups stay distinct and non-cancelling, so the run never
  // nests the shared job-level group.
  for (const [label, workflow, expected] of [
    ["deploy-production.yml", deploy, "deploy-production"],
    ["rollback-production.yml", rollback, "rollback-${{ inputs.environment }}"],
  ]) {
    const header = workflow.slice(0, workflow.indexOf("\njobs:"));
    assert.ok(
      header.includes(`\nconcurrency:\n  group: ${expected}\n  cancel-in-progress: false\n`),
      `${label} keeps its own non-cancelling workflow-level group`,
    );
    assert.ok(
      !header.includes(sharedMutationGroup),
      `${label} must not nest the shared mutation lock at workflow level`,
    );
  }
  // Only the Worker-mutating jobs hold the critical lock: preflight gates and
  // the release-notes call must never hold it.
  const deployMutation = deploy.slice(
    deploy.indexOf("\n  deploy-production:\n"),
    deploy.indexOf("\n  release:\n"),
  );
  const release = deploy.slice(deploy.indexOf("\n  release:\n"));
  assert.ok(deployMutation.includes(sharedMutationGroup), "promotion job must hold the lock");
  assert.ok(!release.includes(sharedMutationGroup), "release notes must not hold the lock");
  const rollbackMutation = rollback.slice(rollback.indexOf("\n  rollback-production:\n"));
  assert.ok(rollbackMutation.includes(sharedMutationGroup), "rollback job must hold the lock");
  for (const [label, workflow, next] of [
    ["deploy-production.yml", deploy, "\n  deploy-production:\n"],
    ["rollback-production.yml", rollback, "\n  rollback-production:\n"],
  ]) {
    const preflight = workflow.slice(workflow.indexOf("\n  preflight:\n"), workflow.indexOf(next));
    assert.ok(
      !preflight.includes(sharedMutationGroup),
      `${label} preflight must not hold the lock`,
    );
  }
});

test("rollback smoke enforces the same public-route set as the gradual live gate", () => {
  // The deploy-time live gate now lives in the shared gradual action; the
  // manual rollback keeps its own copy. Both must run the same shared
  // checker with the same retries, so the two gates cannot drift.
  const action = readFileSync(
    new URL("../.github/actions/gradual-promote/action.yml", import.meta.url),
    "utf8",
  );
  const rollback = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8",
  );
  const live = action.match(
    /    - name: Health and SLO gate at 100 percent \(live traffic\)\n(?:.*\n)*?      run: \|\n((?:        .*\n)+)/,
  )?.[1];
  const manual = rollback.match(
    /      - name: Smoke test public routes on the rolled-back version\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
  )?.[1];
  assert.ok(live && manual);
  for (const step of [live, manual]) {
    assert.match(step, /node bin\/smoke\.mjs /);
    assert.match(step, /for i in 1 2 3 4 5 6/);
    assert.ok(!step.includes("curl "));
  }
  // The action threads --allow-indexable through env (same flag, same
  // checker); the rollback passes it for production only.
  assert.match(live, /\$INDEXABLE/);
  assert.match(
    action,
    /INDEXABLE: \$\{\{ inputs\.allow-indexable == 'true' && '--allow-indexable' \|\| '' \}\}/,
  );
  assert.match(
    manual,
    /if \[ "\$ROLLBACK_INDEXABLE" = "true" \]; then indexable=\(--allow-indexable\); fi/,
  );
  // The gradual live gate probes the production domain through env, like the
  // rollback probes the environment's origin from ci/rollback-target.mjs.
  assert.ok(live.includes('node bin/smoke.mjs "https://$DOMAIN"'));
  assert.ok(
    manual.includes(
      'node bin/smoke.mjs "$ROLLBACK_ORIGIN" "${indexable[@]}" --expected-version-id "$ROLLBACK_VERSION_ID"',
    ),
  );
  assert.match(rollback, /ROLLBACK_ORIGIN: \$\{\{ steps\.target\.outputs\.origin \}\}/);
});

// Automated approval mode (repo variable PRODUCTION_AUTO_APPROVE=true).
const autoEnvironment = {
  name: "production",
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [{ type: "branch_policy" }],
};
// workflow_run runs record main's tip as head_sha; the run-name names the deployed commit.
const tipSha = "c".repeat(40);
function stagingRun(file, id, overrides = {}) {
  return {
    id,
    head_sha: tipSha,
    display_title:
      file === "deploy.yml" ? `deploy ${dispatchSha}` : `e2e-staging deploy ${dispatchSha}`,
    head_branch: "main",
    path: `.github/workflows/${file}`,
    head_repository: { full_name: "fixture/repo" },
    status: "completed",
    conclusion: "success",
    // Long past the 30-minute soak floor unless a test overrides it.
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
function stagingEvidence() {
  return {
    "deploy.yml": [stagingRun("deploy.yml", 100)],
    "e2e-staging.yml": [stagingRun("e2e-staging.yml", 200)],
  };
}
function qualitySteps(conclusions = {}) {
  return stagingQualitySteps.map((name) => ({ name, conclusion: conclusions[name] ?? "success" }));
}
function qualityJob(overrides = {}) {
  return { name: stagingQualityJob, conclusion: "success", steps: qualitySteps(), ...overrides };
}
function e2eJobs(journeys = "success") {
  return [{ name: "staging-journeys", conclusion: journeys }, qualityJob()];
}
function withQuality(quality) {
  return { 200: [{ name: "staging-journeys", conclusion: "success" }, quality] };
}
function stubAutoApi(staging, environment = autoEnvironment, seen = {}) {
  const ci = stubProductionApi(ciEvidence());
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/environments/production")) {
      seen.environment = (seen.environment ?? 0) + 1;
      return { ok: true, json: async () => environment };
    }
    for (const file of ["deploy.yml", "e2e-staging.yml"]) {
      if (parsed.pathname.endsWith(`/workflows/${file}/runs`)) {
        seen[file] = (seen[file] ?? 0) + 1;
        // head_sha is main's tip for workflow_run runs: never filter on it.
        assert.equal(parsed.searchParams.get("head_sha"), null);
        assert.equal(parsed.searchParams.get("branch"), "main");
        const runs = parsed.searchParams.get("page") === "1" ? staging[file] : [];
        return { ok: true, json: async () => ({ total_count: runs.length, workflow_runs: runs }) };
      }
    }
    const jobsOf = parsed.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/)?.[1];
    // Only e2e-staging run ids answer here; CI run job lookups fall through.
    if (jobsOf && (staging["e2e-staging.yml"] ?? []).some((run) => String(run.id) === jobsOf)) {
      const jobs = staging.jobs?.[jobsOf] ?? e2eJobs(staging.journeys?.[jobsOf]);
      return { ok: true, json: async () => ({ jobs }) };
    }
    return ci(url, init);
  };
}
const autoEnv = { ...greenEnv, PRODUCTION_AUTO_APPROVE: "true" };
function checkAuto(staging, environment, seen) {
  return checkProductionGate(autoEnv, stubAutoApi(staging, environment, seen), {
    checkoutSha: dispatchSha,
  });
}

test("auto-approve passes without reviewers when CI, staging deploy and e2e-staging are green on the SHA", async () => {
  const seen = {};
  const evidence = await checkAuto(stagingEvidence(), autoEnvironment, seen);
  assert.equal(evidence.autoApprove, true);
  assert.equal(evidence.sha, dispatchSha);
  assert.deepEqual(evidence.staging, [
    { workflow: "deploy.yml", runId: 100 },
    { workflow: "e2e-staging.yml", runId: 200 },
  ]);
  assert.equal(seen["deploy.yml"], 1);
  assert.equal(seen["e2e-staging.yml"], 1);
});

for (const [name, pattern, mutate] of [
  [
    "no staging deploy",
    /Missing or incomplete exact-SHA deploy\.yml/,
    (s) => (s["deploy.yml"] = []),
  ],
  [
    "no e2e-staging",
    /Missing or incomplete exact-SHA e2e-staging\.yml/,
    (s) => (s["e2e-staging.yml"] = []),
  ],
  [
    "failed e2e-staging",
    /Latest e2e-staging\.yml run on the deployment SHA is not successful/,
    (s) => (s["e2e-staging.yml"][0].conclusion = "failure"),
  ],
  [
    "older success but newer failure",
    /Latest e2e-staging\.yml run/,
    (s) => s["e2e-staging.yml"].push(stagingRun("e2e-staging.yml", 201, { conclusion: "failure" })),
  ],
  [
    "staging deploy still running",
    /Latest deploy\.yml run/,
    (s) =>
      s["deploy.yml"].push(
        stagingRun("deploy.yml", 101, { status: "in_progress", conclusion: null }),
      ),
  ],
  [
    "evidence for another SHA",
    /Missing or incomplete exact-SHA deploy\.yml/,
    (s) => (s["deploy.yml"][0].display_title = `deploy ${otherSha}`),
  ],
  [
    "a manual e2e-staging run (tests whatever staging serves)",
    /Missing or incomplete exact-SHA e2e-staging\.yml/,
    (s) => (s["e2e-staging.yml"][0].display_title = `e2e-staging ${dispatchSha}`),
  ],
  [
    "e2e-staging that skipped its journeys",
    /e2e-staging\.yml run 200 did not pass staging-journeys/,
    (s) => (s.journeys = { 200: "skipped" }),
  ],
  [
    "e2e-staging with no staging quality job",
    /e2e-staging\.yml run 200 has missing or ambiguous staging-quality evidence/,
    (s) => (s.jobs = { 200: [{ name: "staging-journeys", conclusion: "success" }] }),
  ],
  [
    "e2e-staging with two staging quality jobs, one failing",
    /e2e-staging\.yml run 200 has missing or ambiguous staging-quality evidence/,
    (s) => (s.jobs = { 200: [...e2eJobs(), qualityJob({ conclusion: "failure" })] }),
  ],
  [
    "staging quality job skipped under a green e2e-staging run",
    /e2e-staging\.yml run 200 did not execute and pass the staging quality gate/,
    (s) => (s.jobs = withQuality(qualityJob({ conclusion: "skipped", steps: [] }))),
  ],
  [
    "staging quality job failed",
    /e2e-staging\.yml run 200 did not execute and pass the staging quality gate/,
    (s) => (s.jobs = withQuality(qualityJob({ conclusion: "failure" }))),
  ],
  [
    "Lighthouse budget step skipped under a green quality job",
    /e2e-staging\.yml run 200 did not execute and pass the staging quality gate/,
    (s) =>
      (s.jobs = withQuality(
        qualityJob({ steps: qualitySteps({ [stagingQualitySteps[0]]: "skipped" }) }),
      )),
  ],
  [
    "Lighthouse quality step failing under a green quality job",
    /e2e-staging\.yml run 200 did not execute and pass the staging quality gate/,
    (s) =>
      (s.jobs = withQuality(
        qualityJob({ steps: qualitySteps({ [stagingQualitySteps[1]]: "failure" }) }),
      )),
  ],
  [
    "evidence from another branch",
    /e2e-staging\.yml evidence revision\/branch\/workflow mismatch/,
    (s) => (s["e2e-staging.yml"][0].head_branch = "feature"),
  ],
]) {
  test(`auto-approve refuses ${name}`, async () => {
    const staging = stagingEvidence();
    mutate(staging);
    await assert.rejects(checkAuto(staging), pattern);
  });
}

test("auto-approve still requires the main-only branch policy", async () => {
  for (const environment of [
    { ...autoEnvironment, deployment_branch_policy: null },
    {
      ...autoEnvironment,
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    },
    { ...autoEnvironment, protection_rules: [] },
    { ...autoEnvironment, name: "staging" },
  ]) {
    await assert.rejects(
      checkAuto(stagingEvidence(), environment),
      /main-only deployment branch policy/,
    );
  }
});

test("auto-approve's staging quality job and steps are the ones the workflows run", () => {
  const quality = readFileSync(
    new URL("../.github/workflows/web-quality-origin.yml", import.meta.url),
    "utf8",
  );
  const e2e = readFileSync(
    new URL("../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    e2e,
    /\n {2}staging-quality:\n {4}name: staging-quality\n[\s\S]*?uses: \.\/\.github\/workflows\/web-quality-origin\.yml\n/,
  );
  assert.match(quality, /\n {2}quality:\n {4}name: quality\n/);
  assert.equal(stagingQualityJob, "staging-quality / quality");
  for (const step of stagingQualitySteps) {
    assert.ok(quality.includes(`      - name: ${step}\n`), `web-quality-origin.yml runs "${step}"`);
  }
});

test("auto-approve keeps the enable flag and main-only dispatch checks before any API call", async () => {
  await assert.rejects(
    checkProductionGate({ ...autoEnv, PRODUCTION_DEPLOY_ENABLED: "false" }, noNetwork),
    /deployment disabled/,
  );
  await assert.rejects(
    checkProductionGate({ ...autoEnv, GITHUB_REF: "refs/heads/feature" }, noNetwork),
    /workflow_dispatch on main/,
  );
});

for (const flag of [undefined, "", "false", "TRUE", "1", " true"]) {
  test(`without PRODUCTION_AUTO_APPROVE=true (${JSON.stringify(flag)}) a reviewer-less Environment is refused`, async () => {
    await assert.rejects(
      checkProductionGate(
        { ...greenEnv, PRODUCTION_AUTO_APPROVE: flag },
        stubAutoApi(stagingEvidence()),
        { checkoutSha: dispatchSha },
      ),
      /required reviewers and prevent self-review/,
    );
  });
}

test("both production gate steps receive PRODUCTION_AUTO_APPROVE", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const gates = workflow.split("run: node ci/production-deploy-gate.mjs\n").slice(1);
  assert.equal(gates.length, 2);
  for (const gate of gates) {
    const block = gate.split("\n      - ")[0];
    assert.match(block, /PRODUCTION_AUTO_APPROVE: \$\{\{ vars\.PRODUCTION_AUTO_APPROVE \}\}/);
  }
});

for (const job of ["preflight", "rollback-production"]) {
  test(`rollback ${job} gate receives the repository approval mode and dispatch SHA`, () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/rollback-production.yml", import.meta.url),
      "utf8",
    );
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
    assert.ok(block, `${job} job must exist`);
    const gates = block.split("run: node ci/production-deploy-gate.mjs --rollback\n").slice(1);
    assert.equal(gates.length, 1, `${job} must run the shared gate`);
    const gate = gates[0].split("\n      - ")[0];
    assert.match(gate, /ROLLBACK_ENVIRONMENT: \$\{\{ inputs\.environment \}\}/);
    assert.match(gate, /PRODUCTION_AUTO_APPROVE: \$\{\{ vars\.PRODUCTION_AUTO_APPROVE \}\}/);
    assert.match(gate, /PRODUCTION_DEPLOY_ENABLED: \$\{\{ vars\.PRODUCTION_DEPLOY_ENABLED \}\}/);
    assert.match(gate, /DEPLOY_SHA: \$\{\{ inputs\.ref \|\| github\.sha \}\}/);
    assert.match(gate, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  });
}

test("gates the promoted DEPLOY_SHA, never the dispatch-time GITHUB_SHA", async () => {
  // greenEnv carries a different GITHUB_SHA (main tip); evidence and checkout are for DEPLOY_SHA.
  const result = await checkGreen(ciEvidence());
  assert.equal(result.sha, dispatchSha);
});

test("refuses a missing or malformed DEPLOY_SHA before any API call", async () => {
  for (const bad of [undefined, "", "main", dispatchSha.slice(1), `${dispatchSha};id`]) {
    const seen = {};
    const env = { ...greenEnv, DEPLOY_SHA: bad };
    await assert.rejects(
      checkGreen(ciEvidence(), seen, env),
      /DEPLOY_SHA must be a full 40-hex commit/,
    );
  }
});

test("rollback-production passes the checked-out commit as DEPLOY_SHA to both gate steps", () => {
  const rollback = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8",
  );
  const gates = rollback.split("run: node ci/production-deploy-gate.mjs --rollback\n").slice(1);
  assert.equal(gates.length, 2);
  for (const gate of gates) {
    assert.match(
      gate.split("\n      - ")[0],
      /DEPLOY_SHA: \$\{\{ inputs\.ref \|\| github\.sha \}\}/,
    );
  }
  // Both checkouts use the same scripts commit the gate verifies.
  assert.equal(rollback.split("ref: ${{ inputs.ref || github.sha }}").length - 1, 2);
});

test("CI runs the promotion resolver selftest beside the production gate selftest", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /run: node --test ci\/resolve-promotion-sha\.test\.mjs\n/);
  assert.match(ci, /run: node --test ci\/gradual-promote\.test\.mjs\n/);
  assert.match(ci, /run: node --test ci\/gradual-promote-gate-acceptance\.test\.mjs\n/);
});

test("each gradual stage also judges the new version's live error rate before rollback stand-down", () => {
  const action = readFileSync(
    new URL("../.github/actions/gradual-promote/action.yml", import.meta.url),
    "utf8",
  );
  // The live gate sits between the stage's smoke gate and its rollback
  // step, so a fail verdict reaches the same failure-driven rollback.
  const order = [
    "Health and SLO gate at 5 percent",
    "Live error-rate gate at 5 percent",
    "Automatic rollback after 5 percent gate failure",
    "Health and SLO gate at 50 percent",
    "Live error-rate gate at 50 percent",
    "Automatic rollback after 50 percent gate failure",
    "Health and SLO gate at 100 percent (live traffic)",
    "Live error-rate gate at 100 percent",
    "Automatic rollback after 100 percent gate failure",
  ];
  let at = -1;
  for (const name of order) {
    const next = action.indexOf(`- name: ${name}\n`);
    assert.ok(next > at, `error-rate stage out of order or missing: ${name}`);
    at = next;
  }
  assert.equal((action.match(/id: error-rate-(5|50|100)\n/g) ?? []).length, 3);
  // End-of-line anchor: a trailing `|| true` on the run line would
  // neutralize the gate while an unanchored count stays green.
  assert.equal(
    (action.match(/node "\$\{\{ github\.action_path \}\}\/error-rate-gate\.mjs"$/gm) ?? []).length,
    3,
  );
  // The gate reads analytics with the same caller-supplied token/account
  // pair as the wrangler steps; the rehearsal-only fixture override must
  // never be reachable from the production promotion path.
  assert.equal(
    (action.match(/ERROR_RATE_THRESHOLD: \$\{\{ inputs\.error-rate-threshold \}\}/g) ?? []).length,
    3,
  );
  assert.ok(!action.includes("ERROR_RATE_FIXTURE"));
  // Per-step wiring: enabled-only guard (whole line, so `&& false` fails),
  // the promoted version (never the rollback target), and the exact env
  // names configFromEnv parses. Count pins alone let a renamed env var or
  // a repointed NEW_VERSION merge green.
  const stepBlock = (name) => {
    const start = action.indexOf(`    - name: ${name}\n`);
    assert.ok(start >= 0, `step missing: ${name}`);
    const rest = action.slice(start + 1);
    const next = rest.indexOf("\n    - name: ");
    return next < 0 ? rest : rest.slice(0, next);
  };
  // Each smoke gate records when it finished, 1s past the finish: a
  // whole-second stamp would round down, and the analytics lower bound
  // is inclusive, so probes sent in the final second would still count.
  // The error-rate gate starts its judged window there, so the stage's
  // own probes never count. The stamp must fail closed: an empty value
  // would read as "no recorded start" and revive the trailing window.
  assert.equal(
    (
      action.match(
        /finished_at=\$\(node -e "process\.stdout\.write\(new Date\(Date\.now\(\) \+ 1000\)\.toISOString\(\)\)"\)/g,
      ) ?? []
    ).length,
    3,
  );
  assert.equal(
    (
      action.match(
        /if \[ -z "\$finished_at" \]; then echo "::error::could not stamp the smoke finish time" >&2; exit 1; fi/g,
      ) ?? []
    ).length,
    3,
  );
  assert.equal(
    (action.match(/echo "finished-at=\$finished_at" >> "\$GITHUB_OUTPUT"/g) ?? []).length,
    3,
  );
  for (const [pct, smoke] of [
    [5, "smoke-5"],
    [50, "smoke-50"],
    [100, "smoke-100"],
  ]) {
    const block = stepBlock(`Live error-rate gate at ${pct} percent`);
    assert.ok(block.includes("if: inputs.error-rate-gate == 'true'\n"), `gate ${pct} if guard`);
    for (const envLine of [
      "WORKER_NAME: ${{ inputs.worker-name }}",
      "NEW_VERSION: ${{ steps.promoted-version.outputs.id }}",
      "CLOUDFLARE_API_TOKEN: ${{ inputs.api-token }}",
      "CLOUDFLARE_ACCOUNT_ID: ${{ inputs.account-id }}",
      "ERROR_RATE_THRESHOLD: ${{ inputs.error-rate-threshold }}",
      "ERROR_RATE_MIN_REQUESTS: ${{ inputs.error-rate-min-requests }}",
      "ERROR_RATE_WINDOW_MINUTES: ${{ inputs.error-rate-window-minutes }}",
      "ERROR_RATE_SOAK_SECONDS: ${{ inputs.error-rate-soak-seconds }}",
      `ERROR_RATE_WINDOW_START: \${{ steps.${smoke}.outputs.finished-at }}`,
    ]) {
      assert.ok(block.includes(envLine), `gate ${pct} env: ${envLine}`);
    }
    assert.ok(!block.includes("rollback-target"), `gate ${pct} must not read the rollback target`);
    // A swallowed failure would never reach the rollback step.
    assert.ok(!block.includes("continue-on-error"), `gate ${pct} must not swallow its failure`);
  }
});

test("the staging rehearsal requires the elevated-rate verdict, not any non-zero exit", () => {
  const rehearsal = readFileSync(
    new URL("../.github/workflows/error-rate-gate-rehearsal.yml", import.meta.url),
    "utf8",
  );
  // Manual-only staging proof; it must never gain an automatic trigger.
  assert.match(rehearsal, /on:\n  workflow_dispatch:\n/);
  // The simulated half counts as a halt only when the gate judged the
  // fixture's exact elevated sample (200 requests, 80 errors): a malformed
  // fixture also exits non-zero, with verdict=error, and must not read as
  // a successful rehearsal.
  assert.ok(
    rehearsal.includes('grep -F "error-rate requests=200 errors=80 rate=0.4000 verdict=fail"'),
    "rehearsal must require the elevated-rate fail verdict line",
  );
});

// Native automatic production promotion: triggers, live equality, soak/red,
// pending migrations and hold with expiry. Each rule below is pinned in this
// workflow-structure suite (with test/probe-workflows.test.ts) per the card.
test("automatic promotion accepts dispatch, workflow_run and schedule on main only", () => {
  assert.deepEqual([...AUTOMATIC_PROMOTION_EVENTS].sort(), [
    "schedule",
    "workflow_dispatch",
    "workflow_run",
  ]);
  const base = {
    PRODUCTION_DEPLOY_ENABLED: "true",
    GITHUB_REF: "refs/heads/main",
    PRODUCTION_AUTO_APPROVE: "true",
  };
  for (const event of ["workflow_dispatch", "workflow_run", "schedule"]) {
    assert.doesNotThrow(
      () =>
        assertProductionRequest({
          ...base,
          GITHUB_EVENT_NAME: event,
          PRODUCTION_AUTO_APPROVE: event === "workflow_dispatch" ? undefined : "true",
        }),
      event,
    );
  }
  // Automatic triggers without auto-approve have no reviewer to approve the
  // Environment, so they must refuse before any deploy.
  for (const event of ["workflow_run", "schedule"]) {
    assert.throws(
      () =>
        assertProductionRequest({
          ...base,
          GITHUB_EVENT_NAME: event,
          PRODUCTION_AUTO_APPROVE: "false",
        }),
      /PRODUCTION_AUTO_APPROVE/,
      event,
    );
  }
  for (const env of [
    { ...base, GITHUB_EVENT_NAME: "push" },
    { ...base, GITHUB_EVENT_NAME: "pull_request" },
    { ...base, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature" },
  ]) {
    assert.throws(() => assertProductionRequest(env), /workflow_dispatch on main/);
  }
});

test("production hold: empty passes, active holds, expired passes, far-future and malformed refuse", () => {
  const now = Date.parse("2026-10-19T14:00:00Z");
  assert.equal(PRODUCTION_HOLD_MAX_MS, 24 * 60 * 60 * 1000);
  for (const empty of [undefined, "", "   "]) {
    assert.doesNotThrow(() =>
      assertProductionHold({ PRODUCTION_HOLD_UNTIL: empty }, { nowMs: now }),
    );
  }
  // Active hold (now < value, within 24h) refuses.
  assert.throws(
    () => assertProductionHold({ PRODUCTION_HOLD_UNTIL: "2026-10-19T15:00:00Z" }, { nowMs: now }),
    /held until 2026-10-19T15:00:00Z/,
  );
  // Expired hold (now >= value) passes.
  assert.doesNotThrow(() =>
    assertProductionHold({ PRODUCTION_HOLD_UNTIL: "2026-10-19T13:59:59Z" }, { nowMs: now }),
  );
  assert.doesNotThrow(() =>
    assertProductionHold({ PRODUCTION_HOLD_UNTIL: "2026-10-19T14:00:00Z" }, { nowMs: now }),
  );
  // More than 24h ahead refuses even though it is a future hold.
  assert.throws(
    () => assertProductionHold({ PRODUCTION_HOLD_UNTIL: "2026-10-20T14:00:01Z" }, { nowMs: now }),
    /more than 24h ahead/,
  );
  // Exactly 24h ahead is the boundary and passes the far-future check
  // (but still holds, since now < value).
  assert.throws(
    () => assertProductionHold({ PRODUCTION_HOLD_UNTIL: "2026-10-20T14:00:00Z" }, { nowMs: now }),
    /held until/,
  );
  for (const bad of ["tomorrow", "2026-10-19 15:00:00", "2026-10-19T15:00:00", "not-a-date"]) {
    assert.throws(
      () => assertProductionHold({ PRODUCTION_HOLD_UNTIL: bad }, { nowMs: now }),
      /ISO-8601 UTC/,
    );
  }
  // Impossible calendar dates match the shape but never parse: still refuse.
  assert.throws(
    () => assertProductionHold({ PRODUCTION_HOLD_UNTIL: "2026-13-01T00:00:00Z" }, { nowMs: now }),
    /valid UTC timestamp/,
  );
});

test("production hold blocks the gate before any API call", async () => {
  const held = {
    ...enabled,
    PRODUCTION_HOLD_UNTIL: new Date(Date.now() + 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z"),
  };
  await assert.rejects(checkProductionGate(held, noNetwork), /held until/);
});

test("both production gate steps receive the hold variable", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const gates = workflow.split("run: node ci/production-deploy-gate.mjs\n").slice(1);
  assert.equal(gates.length, 2);
  for (const gate of gates) {
    assert.match(
      gate.split("\n      - ")[0],
      /PRODUCTION_HOLD_UNTIL: \$\{\{ vars\.PRODUCTION_HOLD_UNTIL \}\}/,
    );
  }
});

test("live equality: same commit is already live, different or unknown is not", () => {
  const deploy = "a".repeat(40);
  assert.equal(isAlreadyLive(deploy, deploy), true);
  assert.equal(isAlreadyLive(deploy.toUpperCase(), deploy), true);
  assert.equal(isAlreadyLive(deploy, "b".repeat(40)), false);
  assert.equal(isAlreadyLive(deploy, null), false);
  assert.equal(isAlreadyLive(deploy, ""), false);
  assert.equal(isAlreadyLive("", deploy), false);
  assert.equal(PRODUCTION_ORIGIN, "https://togetherweown.com");
});

test("live commit reads the /up revision marker and fails open to null", async () => {
  const sha = "c".repeat(40);
  const ok = await readLiveProductionCommit({
    fetchImpl: async () => ({ json: async () => ({ revision: { commit: sha } }) }),
  });
  assert.equal(ok, sha);
  for (const body of [
    {},
    { revision: null },
    { revision: {} },
    { revision: { commit: "not-a-sha" } },
  ]) {
    assert.equal(
      await readLiveProductionCommit({ fetchImpl: async () => ({ json: async () => body }) }),
      null,
    );
  }
  assert.equal(
    await readLiveProductionCommit({
      fetchImpl: async () => {
        throw new Error("down");
      },
    }),
    null,
  );
});

test("pending migrations are target tags the live journal lacks", () => {
  assert.deepEqual(pendingMigrationTags(["a", "b", "c"], ["a", "b"]), ["c"]);
  assert.deepEqual(pendingMigrationTags(["a", "b"], ["a", "b"]), []);
  assert.deepEqual(pendingMigrationTags([], ["a"]), []);
  assert.deepEqual(pendingMigrationTags(["a"], []), ["a"]);
});

test("pending migration lookup compares journals at both commits and passes on unknown live", async () => {
  const journal = (tags) => ({
    content: Buffer.from(JSON.stringify({ entries: tags.map((tag) => ({ tag })) })).toString(
      "base64",
    ),
    encoding: "base64",
  });
  const targetSha = "a".repeat(40);
  const liveSha = "b".repeat(40);
  const fetchImpl = async (url) => {
    const ref = new URL(url).searchParams.get("ref");
    const tags = ref === targetSha ? ["0000_a", "0001_b"] : ["0000_a"];
    return { ok: true, json: async () => journal(tags) };
  };
  assert.deepEqual(
    await pendingProductionMigrations({
      repository: "o/r",
      targetSha,
      liveSha,
      token: "t",
      fetchImpl,
    }),
    ["0001_b"],
  );
  assert.deepEqual(
    await pendingProductionMigrations({
      repository: "o/r",
      targetSha,
      liveSha: null,
      token: "t",
      fetchImpl,
    }),
    [],
  );
  await assert.rejects(
    pendingProductionMigrations({
      repository: "o/r",
      targetSha: "short",
      liveSha,
      token: "t",
      fetchImpl,
    }),
    /40-hex/,
  );
});

test("target web entries are the 1000-series journal entries", () => {
  const entries = [
    { tag: "0000_init", when: 1 },
    { tag: "1000_a", when: 1000 },
    { tag: "1001_b", when: 1001 },
  ];
  assert.deepEqual(
    targetWebEntries(entries).map((entry) => entry.tag),
    ["1000_a", "1001_b"],
  );
  assert.deepEqual(targetWebEntries([]), []);
  assert.deepEqual(targetWebEntries(null), []);
});

test("unknown target web end fails closed on timestamp-less web entries", () => {
  assert.equal(
    targetWebEndUnknown([
      { tag: "1000_a", when: 1000 },
      { tag: "1001_b", when: 1001 },
    ]),
    false,
  );
  assert.equal(targetWebEndUnknown([]), false);
  assert.equal(targetWebEndUnknown([{ tag: "1000_a" }]), true);
  assert.equal(targetWebEndUnknown([{ tag: "1000_a", when: "1000" }]), true);
  // Grandfathered non-web entries stay outside the proof.
  assert.equal(targetWebEndUnknown([{ tag: "0000_init" }]), false);
});

test("ledger-pending tags are target web entries missing from the applied set", () => {
  const target = [
    { tag: "0000_init", when: 1 },
    { tag: "1000_a", when: 1000 },
    { tag: "1001_b", when: 1001 },
    { tag: "1002_c", when: 1002 },
  ];
  assert.deepEqual(pendingLedgerTags(target, [1, 1000, 1001, 1002]), []);
  assert.deepEqual(pendingLedgerTags(target, [1, 1000, 1001, 1002, 9999999999999]), []);
  assert.deepEqual(pendingLedgerTags(target, [1, 1000, 9999999999999]), ["1001_b", "1002_c"]);
  // A newer foreign row cannot hide a missing web migration: inclusion, not a max.
  assert.deepEqual(pendingLedgerTags(target, [9999999999999]), ["1000_a", "1001_b", "1002_c"]);
  assert.deepEqual(pendingLedgerTags(target, []), ["1000_a", "1001_b", "1002_c"]);
  assert.throws(() => pendingLedgerTags(target, null), /migration_ledger/);
  assert.throws(() => pendingLedgerTags(target, [1000, "1001"]), /migration_ledger/);
});

test("ledger state requires a current database and the applied set", () => {
  assert.deepEqual(
    readLedgerState({ db: "ok", pending_migrations: 0, migration_ledger: [1000, 1001] }),
    [1000, 1001],
  );
  assert.deepEqual(readLedgerState({ db: "ok", pending_migrations: 0, migration_ledger: [] }), []);
  for (const body of [
    { db: "error", pending_migrations: null, migration_ledger: null },
    // Isolated db arm: pending and ledger are valid, only db is bad. Deleting
    // the body?.db !== "ok" disjunct in readLedgerState must turn this red.
    { db: "error", pending_migrations: 0, migration_ledger: [1000, 1001] },
    { db: "ok", pending_migrations: 1, migration_ledger: [1000, 1001] },
    { db: "ok", pending_migrations: 0, migration_ledger: null },
    { db: "ok", pending_migrations: 0, migration_ledger: [1000, "1001"] },
    { db: "ok", pending_migrations: 0 },
    {},
  ]) {
    assert.throws(() => readLedgerState(body), /ledger/i);
  }
});

test("live ledger read fails closed with a ledger reason on transport errors", async () => {
  const applied = await readLiveProductionLedger({
    fetchImpl: async () => ({
      json: async () => ({ db: "ok", pending_migrations: 0, migration_ledger: [40, 41, 42] }),
    }),
  });
  assert.deepEqual(applied, [40, 41, 42]);
  await assert.rejects(
    readLiveProductionLedger({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    }),
    /ledger read failed/,
  );
  await assert.rejects(
    readLiveProductionLedger({
      fetchImpl: async () => ({
        json: async () => ({ db: "error", pending_migrations: null, migration_ledger: null }),
      }),
    }),
    /ledger/i,
  );
});

test("pending migrations stop the promotion with a migrator-blocked error (CLI)", () => {
  // The workflow step message must name db-migrate.yml and the blocker.
  const gate = readFileSync(new URL("./production-deploy-gate.mjs", import.meta.url), "utf8");
  assert.match(gate, /run db-migrate\.yml \(target production\) first/);
  assert.match(gate, /least-privilege migrator/);
});

// Spawned CLI branch tests: behavior pins, not source greps. Neutralizing the
// pending-stop, inverting the already_live output, dropping the live retry, or
// collapsing the auto/manual split must fail here.
function spawnGateCli(args, env, stub) {
  const dir = mkdtempSync(join(tmpdir(), "gate-cli-"));
  const output = join(dir, "output");
  const result = spawnSync(
    process.execPath,
    ["--import", "./ci/test-fetch-stub.mjs", "ci/production-deploy-gate.mjs", ...args],
    {
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        FETCH_STUB_JSON: JSON.stringify(stub),
        ...env,
      },
      encoding: "utf8",
    },
  );
  let written = "";
  try {
    written = readFileSync(output, "utf8");
  } catch {
    written = "";
  }
  return { ...result, written };
}

const journalBody = (tags) => ({
  content: Buffer.from(JSON.stringify({ entries: tags.map((tag) => ({ tag })) })).toString(
    "base64",
  ),
  encoding: "base64",
});

test("already-live CLI reports exact GITHUB_OUTPUT for live, stale and unreadable production", () => {
  const target = "a".repeat(40);
  const live = "b".repeat(40);
  const origin = "http://stub.invalid";
  const served = spawnGateCli(
    ["--already-live"],
    { DEPLOY_SHA: target, PRODUCTION_ORIGIN: origin },
    [{ match: "/up", body: { revision: { commit: target } } }],
  );
  assert.equal(served.status, 0);
  assert.equal(served.written, `already_live=true\nlive_sha=${target}\n`);
  assert.match(served.stdout, /skipping deploy/);
  const stale = spawnGateCli(
    ["--already-live"],
    { DEPLOY_SHA: target, PRODUCTION_ORIGIN: origin },
    [{ match: "/up", body: { revision: { commit: live } } }],
  );
  assert.equal(stale.status, 0);
  assert.equal(stale.written, `already_live=false\nlive_sha=${live}\n`);
  assert.match(stale.stdout, /promoting/);
  // An unreadable /up never counts as live: fail open toward deploying.
  const down = spawnGateCli(["--already-live"], { DEPLOY_SHA: target, PRODUCTION_ORIGIN: origin }, [
    { match: "/up", fail: true },
  ]);
  assert.equal(down.status, 0);
  assert.equal(down.written, "already_live=false\nlive_sha=\n");
  assert.match(down.stdout, /unreadable/);
});

test("check-migrations CLI passes a clean journal comparison", () => {
  const target = "a".repeat(40);
  const live = "b".repeat(40);
  const result = spawnGateCli(
    ["--check-migrations"],
    {
      DEPLOY_SHA: target,
      LIVE_SHA: live,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: "t",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    },
    [
      { match: `ref=${target}`, body: journalBody(["0000_a", "0001_b"]) },
      { match: `ref=${live}`, body: journalBody(["0000_a", "0001_b"]) },
    ],
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No pending production migrations/);
});

test("check-migrations CLI stops manual dispatch until db-migrate plus audited confirmation", () => {
  const target = "a".repeat(40);
  const live = "b".repeat(40);
  const journals = [
    { match: `ref=${target}`, body: journalBody(["0000_a", "0001_b"]) },
    { match: `ref=${live}`, body: journalBody(["0000_a"]) },
  ];
  const base = {
    DEPLOY_SHA: target,
    LIVE_SHA: live,
    GITHUB_REPOSITORY: "o/r",
    GITHUB_TOKEN: "t",
    GITHUB_EVENT_NAME: "workflow_dispatch",
  };
  const stopped = spawnGateCli(["--check-migrations"], base, journals);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /0001_b/);
  assert.match(stopped.stderr, /run db-migrate\.yml \(target production\) first/);
  assert.match(stopped.stderr, /migrations_applied=true/);
  // The workflow renders the boolean input default as the string "false",
  // so only the exact "true" confirmation releases the stop.
  const defaulted = spawnGateCli(
    ["--check-migrations"],
    { ...base, MIGRATIONS_APPLIED: "false" },
    journals,
  );
  assert.equal(defaulted.status, 1);
  assert.match(defaulted.stderr, /run db-migrate\.yml \(target production\) first/);
  // After db-migrate applied the entries, the operator-confirmed re-dispatch
  // continues with an audited log line naming the pending tags.
  const continued = spawnGateCli(
    ["--check-migrations"],
    { ...base, MIGRATIONS_APPLIED: "true" },
    journals,
  );
  assert.equal(continued.status, 0);
  assert.match(continued.stdout, /Manual continuation/);
  assert.match(continued.stdout, /0001_b/);
});

test("check-migrations CLI keeps automatic promotion blocked on pending entries", () => {
  const target = "a".repeat(40);
  const live = "b".repeat(40);
  const journals = [
    { match: `ref=${target}`, body: journalBody(["0000_a", "0001_b"]) },
    { match: `ref=${live}`, body: journalBody(["0000_a"]) },
  ];
  // An operator confirmation must never release an automatic run.
  for (const event of ["workflow_run", "schedule"]) {
    const result = spawnGateCli(
      ["--check-migrations"],
      {
        DEPLOY_SHA: target,
        LIVE_SHA: live,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_TOKEN: "t",
        GITHUB_EVENT_NAME: event,
        MIGRATIONS_APPLIED: "true",
      },
      journals,
    );
    assert.equal(result.status, 1, event);
    assert.match(result.stderr, /least-privilege migrator/);
  }
});

test("check-migrations CLI refuses unknown-live manual promotion without audited continuation", () => {
  const target = "a".repeat(40);
  const down = [{ match: "/up", fail: true }];
  const base = {
    DEPLOY_SHA: target,
    GITHUB_REPOSITORY: "o/r",
    GITHUB_TOKEN: "t",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    PRODUCTION_ORIGIN: "http://stub.invalid",
    MIGRATIONS_APPLIED: "",
  };
  // The live commit stays unreadable after every retry: a manual dispatch
  // must not promote past an unknown live state on a warning alone. The
  // refusal names the audited continuation that releases it.
  const refused = spawnGateCli(["--check-migrations"], base, down);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unknown/i);
  assert.match(refused.stderr, /migrations_applied=true/);
  // The workflow renders the boolean input default as the string "false",
  // so only the exact "true" confirmation releases the refusal.
  const defaulted = spawnGateCli(
    ["--check-migrations"],
    { ...base, MIGRATIONS_APPLIED: "false" },
    down,
  );
  assert.equal(defaulted.status, 1);
  assert.match(defaulted.stderr, /migrations_applied=true/);
});

test("check-migrations CLI continues unknown-live manual promotion only with audited confirmation", () => {
  const target = "a".repeat(40);
  const continued = spawnGateCli(
    ["--check-migrations"],
    {
      DEPLOY_SHA: target,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: "t",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      PRODUCTION_ORIGIN: "http://stub.invalid",
      MIGRATIONS_APPLIED: "true",
    },
    [{ match: "/up", fail: true }],
  );
  assert.equal(continued.status, 0);
  // The continuation is auditable from the log alone: it is a manual
  // continuation, against an unknown live commit, for this target, on the
  // operator's named confirmation.
  assert.match(continued.stdout, /Manual continuation/);
  assert.match(continued.stdout, /unknown/i);
  assert.ok(continued.stdout.includes(target));
  assert.match(continued.stdout, /migrations_applied=true/);
});

test("check-migrations CLI keeps automatic promotion halted on unknown live", () => {
  const target = "a".repeat(40);
  const down = [{ match: "/up", fail: true }];
  const halted = spawnGateCli(
    ["--check-migrations"],
    {
      DEPLOY_SHA: target,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: "t",
      GITHUB_EVENT_NAME: "schedule",
      PRODUCTION_ORIGIN: "http://stub.invalid",
    },
    down,
  );
  assert.equal(halted.status, 1);
  assert.match(halted.stderr, /halting automatic promotion for a later retry/);
  // An operator confirmation must never release an automatic run: the
  // audited continuation is manual-only, automatic runs wait for a retry.
  for (const event of ["workflow_run", "schedule"]) {
    const confirmed = spawnGateCli(
      ["--check-migrations"],
      {
        DEPLOY_SHA: target,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_TOKEN: "t",
        GITHUB_EVENT_NAME: event,
        PRODUCTION_ORIGIN: "http://stub.invalid",
        MIGRATIONS_APPLIED: "true",
      },
      down,
    );
    assert.equal(confirmed.status, 1, event);
    assert.match(confirmed.stderr, /halting automatic promotion for a later retry/);
  }
});

test("check-migrations CLI recovers when an unreadable live commit succeeds on retry", () => {
  const target = "a".repeat(40);
  const live = "b".repeat(40);
  const journals = [
    { match: `ref=${target}`, body: journalBody(["0000_a"]) },
    { match: `ref=${live}`, body: journalBody(["0000_a"]) },
  ];
  // A flapping /up that recovers on the third read proceeds to the journal
  // comparison: a single-read implementation would treat live as unknown
  // and refuse here instead.
  const recovered = spawnGateCli(
    ["--check-migrations"],
    {
      DEPLOY_SHA: target,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: "t",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      PRODUCTION_ORIGIN: "http://stub.invalid",
    },
    [
      {
        match: "/up",
        sequence: [{ fail: true }, { fail: true }, { body: { revision: { commit: live } } }],
      },
      ...journals,
    ],
  );
  assert.equal(recovered.status, 0);
  assert.match(recovered.stdout, /No pending production migrations/);
});

test("check-migrations CLI halts closed with a ledger reason when the ledger is unreachable", () => {
  const target = "a".repeat(40);
  const live = "b".repeat(40);
  const stub = [
    { match: `ref=${target}`, body: journalBody(["0000_a", "0001_b"]) },
    { match: `ref=${live}`, body: journalBody(["0000_a"]) },
    { match: "/up", fail: true },
  ];
  const base = {
    DEPLOY_SHA: target,
    LIVE_SHA: live,
    GITHUB_REPOSITORY: "o/r",
    GITHUB_TOKEN: "t",
    PRODUCTION_ORIGIN: "http://stub.invalid",
  };
  // Automatic: stays stopped, keeps the migrator-blocked reason, names the ledger failure.
  const automatic = spawnGateCli(
    ["--check-migrations"],
    { ...base, GITHUB_EVENT_NAME: "schedule" },
    stub,
  );
  assert.equal(automatic.status, 1);
  assert.match(automatic.stderr, /ledger/i);
  assert.match(automatic.stderr, /0001_b/);
  assert.match(automatic.stderr, /least-privilege migrator/);
  // Manual: keeps the db-migrate guidance and the audited continuation.
  const manual = spawnGateCli(
    ["--check-migrations"],
    { ...base, GITHUB_EVENT_NAME: "workflow_dispatch" },
    stub,
  );
  assert.equal(manual.status, 1);
  assert.match(manual.stderr, /ledger/i);
  assert.match(manual.stderr, /run db-migrate\.yml \(target production\) first/);
  assert.match(manual.stderr, /migrations_applied=true/);
});

test("check-migrations CLI halts closed when the live Worker predates the ledger signal", () => {
  const target = "a".repeat(40);
  const live = "b".repeat(40);
  const dated = (entries) => ({
    content: Buffer.from(JSON.stringify({ entries })).toString("base64"),
    encoding: "base64",
  });
  const result = spawnGateCli(
    ["--check-migrations"],
    {
      DEPLOY_SHA: target,
      LIVE_SHA: live,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_TOKEN: "t",
      GITHUB_EVENT_NAME: "schedule",
      PRODUCTION_ORIGIN: "http://stub.invalid",
    },
    [
      {
        match: `ref=${target}`,
        body: dated([
          { tag: "1000_a", when: 1000 },
          { tag: "1001_b", when: 1001 },
        ]),
      },
      { match: `ref=${live}`, body: dated([{ tag: "1000_a", when: 1000 }]) },
      {
        match: "/up",
        body: { revision: { commit: live }, db: "ok", pending_migrations: 0 },
      },
    ],
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /migration_ledger/);
});

// Rollback gate (rollback-production.yml --rollback), per environment.
test("production rollback skips staging evidence under auto-approve: it serves a prior version", async () => {
  const seen = {};
  const evidence = await checkRollbackGate(
    { ...autoEnv, ROLLBACK_ENVIRONMENT: "production" },
    stubAutoApi({ "deploy.yml": [], "e2e-staging.yml": [] }, autoEnvironment, seen),
    { checkoutSha: dispatchSha },
  );
  assert.deepEqual(evidence, { sha: dispatchSha, runId: 42, runAttempt: 1 });
  assert.equal(seen.environment, 1);
  assert.equal(seen["deploy.yml"], undefined);
  assert.equal(seen["e2e-staging.yml"], undefined);
});

test("production rollback never waits on a hold, but keeps the enable flag and red-CI refusal", async () => {
  const held = {
    ...greenEnv,
    ROLLBACK_ENVIRONMENT: "production",
    PRODUCTION_HOLD_UNTIL: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  const evidence = await checkRollbackGate(held, stubProductionApi(ciEvidence()), {
    checkoutSha: dispatchSha,
  });
  assert.equal(evidence.sha, dispatchSha);
  await assert.rejects(
    checkProductionGate(held, noNetwork, { checkoutSha: dispatchSha }),
    /held until/,
  );
  await assert.rejects(
    checkRollbackGate({ ...held, PRODUCTION_DEPLOY_ENABLED: "false" }, noNetwork),
    /deployment disabled/,
  );
  const red = ciEvidence();
  red.runs.workflow_runs[0].conclusion = "failure";
  await assert.rejects(
    checkRollbackGate(held, stubProductionApi(red), { checkoutSha: dispatchSha }),
    /Full CI has not completed successfully/,
  );
});

test("staging rollback needs main and green CI, never the production Environment", async () => {
  const seen = {};
  const env = { ...greenEnv, PRODUCTION_DEPLOY_ENABLED: "", ROLLBACK_ENVIRONMENT: "staging" };
  for (const event of ["workflow_dispatch", "schedule", "workflow_run"]) {
    const evidence = await checkRollbackGate(
      { ...env, GITHUB_EVENT_NAME: event },
      stubProductionApi(ciEvidence(), seen),
      { checkoutSha: dispatchSha },
    );
    assert.equal(evidence.sha, dispatchSha);
  }
  assert.equal(seen.environment, undefined);
  for (const override of [
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/feature" },
  ]) {
    await assert.rejects(checkRollbackGate({ ...env, ...override }, noNetwork), /on main/);
  }
  await assert.rejects(
    checkRollbackGate({ ...env, DEPLOY_SHA: "main" }, noNetwork),
    /DEPLOY_SHA must be a full 40-hex commit/,
  );
  await assert.rejects(
    checkRollbackGate(env, stubProductionApi(ciEvidence()), { checkoutSha: otherSha }),
  );
});

test("rollback gate refuses an unknown environment before any API call", async () => {
  for (const name of [undefined, "", "Production", "preview", "staging "]) {
    await assert.rejects(
      checkRollbackGate({ ...greenEnv, ROLLBACK_ENVIRONMENT: name }, noNetwork),
      /ROLLBACK_ENVIRONMENT must be production or staging/,
    );
  }
});

test("auto-approve refuses an e2e-staging pass younger than the 30-minute soak, on every trigger", async () => {
  for (const [label, updated_at] of [
    ["10 minutes old", new Date(Date.now() - 10 * 60 * 1000).toISOString()],
    ["missing", undefined],
    ["unparsable", "yesterday"],
  ]) {
    const staging = stagingEvidence();
    staging["e2e-staging.yml"] = [stagingRun("e2e-staging.yml", 200, { updated_at })];
    for (const event of ["workflow_dispatch", "workflow_run", "schedule"]) {
      await assert.rejects(
        checkProductionGate(
          { ...autoEnv, GITHUB_EVENT_NAME: event },
          stubAutoApi(staging, autoEnvironment),
          { checkoutSha: dispatchSha },
        ),
        /has not soaked 30 minutes since it passed/,
        label,
      );
    }
  }
  const soaked = stagingEvidence();
  soaked["e2e-staging.yml"] = [
    stagingRun("e2e-staging.yml", 200, {
      updated_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    }),
  ];
  assert.equal((await checkAuto(soaked, autoEnvironment)).autoApprove, true);
});
