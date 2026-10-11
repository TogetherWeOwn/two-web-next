import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readWranglerConfig } from "./wrangler-config.mjs";
import {
  assertProductionCredentials,
  assertProductionProtection,
  assertProductionTarget,
  assertRollbackVersionId,
  checkProductionGate,
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
    () => assertProductionTarget(targetConfig([{ binding: "DB", id: sentinel }])),
    /still a placeholder/,
  );
  assert.doesNotThrow(() =>
    assertProductionTarget(targetConfig([{ binding: "DB", id: provisionedId }])),
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

function assertIsolatedBindings(config) {
  const production = config.env.production;
  assert.notEqual(production.name, config.name);
  assert.equal(production.workers_dev, false);
  assert.equal(production.preview_urls, false);
  assert.deepEqual(production.routes, [{ pattern: "togetherweown.com", custom_domain: true }]);
  assert.equal(production.vars.APP_URL, "https://togetherweown.com");
  assert.equal(production.vars.QA_AUTH_TOKEN, undefined);
  assert.notEqual(production.hyperdrive[0].id, config.hyperdrive[0].id);
  assert.deepEqual(production.triggers, config.triggers);
  const stagingQueues = config.queues.producers.map((producer) => producer.queue);
  for (const producer of production.queues.producers) {
    assert.ok(!stagingQueues.includes(producer.queue));
    assert.ok(production.queues.consumers.some((consumer) => consumer.queue === producer.queue));
  }
}

test("actual production config retains isolated bindings before and after sentinel replacement", () => {
  const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = readWranglerConfig(text);
  assertIsolatedBindings(config);
  const provisioned = structuredClone(config);
  provisioned.env.production.hyperdrive[0].id = "11111111111111111111111111111111";
  assertIsolatedBindings(provisioned);
  assert.doesNotThrow(() => assertProductionTarget(JSON.stringify(provisioned)));
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

test("both Environment gate jobs inherit contents and Actions read permissions", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^permissions:\n  contents: read\n  actions: read\n/m);
  // The post-deploy `release` call (release.yml) is the only job override: it
  // runs after both gate jobs and needs only contents: write to tag the commit.
  const release = workflow.slice(workflow.indexOf("\n  release:\n"));
  assert.match(release, /^ {4}permissions:\n {6}contents: write[^\n]*\n(?! {6})/m);
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

test("manual production workflow routes runners by repo visibility and uses production-only secrets", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  // Self-hosted while private; GitHub-hosted only while public (TOG-12326).
  const runsOn = `runs-on: \${{ github.event.repository.private && fromJSON('["self-hosted","two-selfhosted"]') || 'ubuntu-latest' }}\n`;
  assert.equal(workflow.split(runsOn).length - 1, 2);
  assert.equal(
    workflow.split("ubuntu-latest").length - 1,
    2,
    "ubuntu-latest only as the public-repo branch",
  );
  assert.ok(!workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(!workflow.includes("secrets.CLOUDFLARE_ACCOUNT_ID"));
  for (const key of Object.keys(credentials)) {
    // Credentials check, required-secrets preflight, production Tail deploy,
    // app deploy: all production-only.
    assert.equal((workflow.match(new RegExp(`secrets\\.PRODUCTION_${key}`, "g")) ?? []).length, 4);
  }
  const credentialCheck = workflow.indexOf("run: node ci/production-deploy-gate.mjs --credentials");
  const requiredSecrets = workflow.indexOf("run: node ci/check-production-secrets.mjs");
  const tailDeploy = workflow.indexOf(
    "run: npx wrangler deploy --config tail/wrangler.jsonc --env production",
  );
  const deploy = workflow.indexOf("run: npx wrangler deploy --env production");
  assert.ok(
    credentialCheck > 0 &&
      credentialCheck < requiredSecrets &&
      requiredSecrets < tailDeploy &&
      tailDeploy < deploy,
  );
});

test("rollback workflow reuses the production gate with no wider permissions", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8",
  );
  // Manual-only on main: no push, PR, release or completion trigger.
  assert.match(workflow, /\n  workflow_dispatch:\n/);
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
  // Production Environment approval with required reviewers; never cancelled.
  assert.match(workflow, /environment:\n      name: production\n/);
  assert.match(workflow, /cancel-in-progress: false/);
  // Same request gate as a deploy, in both jobs.
  assert.equal((workflow.match(/run: node ci\/production-deploy-gate\.mjs\n/g) ?? []).length, 2);
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
  // Production-only secrets, credential check before the mutation.
  assert.ok(!workflow.includes("secrets.CLOUDFLARE_API_TOKEN"));
  assert.ok(!workflow.includes("secrets.CLOUDFLARE_ACCOUNT_ID"));
  for (const key of Object.keys(credentials)) {
    assert.equal((workflow.match(new RegExp(`secrets\\.PRODUCTION_${key}`, "g")) ?? []).length, 2);
  }
  const versionCheck = workflow.indexOf("run: node ci/production-deploy-gate.mjs --version-id");
  const credentialCheck = workflow.indexOf("run: node ci/production-deploy-gate.mjs --credentials");
  const rollback = workflow.indexOf(
    'run: npx wrangler rollback "$ROLLBACK_VERSION_ID" --name two-web-next-production',
  );
  assert.ok(rollback > 0);
  assert.ok(versionCheck > 0 && versionCheck < credentialCheck && credentialCheck < rollback);
  // The input never interpolates into a run: block; it travels inputs -> env.
  for (const line of workflow.split("\n")) {
    if (line.trimStart().startsWith("run:") && line.includes("inputs.version_id")) {
      assert.fail(`input interpolates into a run: block: ${line}`);
    }
  }
  assert.match(workflow, /ROLLBACK_VERSION_ID: \$\{\{ inputs\.version_id \}\}/);
});

test("rollback smoke enforces the same public-route set as the deploy smoke", () => {
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const rollback = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8",
  );
  const block = (text) =>
    text.match(
      /      - name: Smoke test production public routes\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
    )?.[1];
  assert.ok(block(deploy) && block(rollback));
  // Identical checks and retries; only the failure message names the operation.
  assert.equal(block(rollback), block(deploy).replaceAll("after deploy", "after rollback"));
  // GET-only public-route set through the shared checker; no curl /up one-off.
  for (const step of [block(deploy), block(rollback)]) {
    assert.match(step, /node bin\/smoke\.mjs https:\/\/togetherweown\.com --allow-indexable/);
    assert.ok(!step.includes("curl "));
  }
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
    ...overrides,
  };
}
function stagingEvidence() {
  return {
    "deploy.yml": [stagingRun("deploy.yml", 100)],
    "e2e-staging.yml": [stagingRun("e2e-staging.yml", 200)],
  };
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
      const conclusion = staging.journeys?.[jobsOf] ?? "success";
      return { ok: true, json: async () => ({ jobs: [{ name: "staging-journeys", conclusion }] }) };
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
  const gates = rollback.split("run: node ci/production-deploy-gate.mjs\n").slice(1);
  assert.equal(gates.length, 2);
  for (const gate of gates) {
    assert.match(gate.split("\n      - ")[0], /DEPLOY_SHA: \$\{\{ github\.sha \}\}/);
  }
});

test("CI runs the promotion resolver selftest beside the production gate selftest", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /run: node --test ci\/resolve-promotion-sha\.test\.mjs\n/);
});
