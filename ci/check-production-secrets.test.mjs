import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  REQUIRED_PRODUCTION_SECRETS,
  checkProductionSecrets,
  checkRollbackVersionSecrets,
  missingRequiredSecrets,
  parseSecretNames,
  parseVersionSecretNames,
} from "./check-production-secrets.mjs";

const allPresent = JSON.stringify([
  { name: "SESSION_SECRET" },
  { name: "DISCORD_CLIENT_SECRET" },
  { name: "DISCORD_BOT_TOKEN" },
]);

test("all required secrets present passes and returns the required names", () => {
  assert.deepEqual(checkProductionSecrets(allPresent), [...REQUIRED_PRODUCTION_SECRETS]);
});

test("one missing secret fails and names only the missing secret", () => {
  for (const missing of REQUIRED_PRODUCTION_SECRETS) {
    const stub = JSON.stringify(
      REQUIRED_PRODUCTION_SECRETS.filter((name) => name !== missing).map((name) => ({ name })),
    );
    assert.throws(
      () => checkProductionSecrets(stub),
      (error) => {
        assert.match(error.message, /Missing production Worker secret/);
        assert.ok(error.message.includes(missing), `error must name ${missing}`);
        for (const present of REQUIRED_PRODUCTION_SECRETS.filter((name) => name !== missing)) {
          assert.ok(
            !error.message.includes(present),
            `error must not echo present secret ${present}`,
          );
        }
        return true;
      },
    );
  }
});

test("empty listing fails closed naming every required secret", () => {
  assert.throws(
    () => checkProductionSecrets("[]"),
    (error) => {
      for (const name of REQUIRED_PRODUCTION_SECRETS) {
        assert.ok(error.message.includes(name), `error must name ${name}`);
      }
      return true;
    },
  );
});

for (const stub of [
  "",
  "not json",
  '{"name":"SESSION_SECRET"}',
  '"SESSION_SECRET"',
  "null",
  "[{}]",
  '[{"name":""}]',
  '[{"name":null}]',
  '[{"name":42}]',
  "[null]",
  '["SESSION_SECRET"]',
  `${allPresent} trailing`,
]) {
  test(`malformed wrangler output fails closed (${JSON.stringify(stub).slice(0, 60)})`, () => {
    assert.throws(() => checkProductionSecrets(stub), /Could not verify production Worker secrets/);
  });
}

test("extra fields that resemble values are ignored and never surface", () => {
  // If wrangler ever added value-bearing fields, they must not leak into
  // results, errors or CLI output. Fixture values are fake and never real.
  const stub = JSON.stringify([
    { name: "SESSION_SECRET", value: "fixture-fake-value-aaa" },
    { name: "DISCORD_CLIENT_SECRET", secret: "fixture-fake-value-bbb" },
    { name: "DISCORD_BOT_TOKEN", extra: { nested: "fixture-fake-value-ccc" } },
  ]);
  assert.deepEqual(checkProductionSecrets(stub), [...REQUIRED_PRODUCTION_SECRETS]);
  const names = parseSecretNames(stub);
  assert.equal(names.size, 3);
  const missing = missingRequiredSecrets(new Set(["SESSION_SECRET"]));
  assert.deepEqual(missing, ["DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN"]);
  assert.throws(
    () =>
      checkProductionSecrets(
        JSON.stringify([{ name: "SESSION_SECRET", value: "fixture-fake-value-aaa" }]),
      ),
    (error) => {
      assert.ok(
        !error.message.includes("fixture-fake-value"),
        "error must never echo value-like fields",
      );
      return true;
    },
  );
});

const versionAllPresent = JSON.stringify({
  id: "11111111-2222-4333-8444-555555555555",
  resources: {
    bindings: [
      { name: "SESSION_SECRET", type: "secret_text" },
      { name: "DISCORD_CLIENT_SECRET", type: "secret_text" },
      { name: "DISCORD_BOT_TOKEN", type: "secret_text" },
      { name: "DISCORD_GUILD_ID", type: "plain_text", text: "fixture-guild" },
    ],
  },
});

test("rollback target version with all required secret_text bindings passes", () => {
  assert.deepEqual(checkRollbackVersionSecrets(versionAllPresent), [
    ...REQUIRED_PRODUCTION_SECRETS,
  ]);
  const names = parseVersionSecretNames(versionAllPresent);
  assert.equal(names.size, 3);
  assert.ok(names.has("SESSION_SECRET"));
});

test("rollback target version missing a secret names only the missing secret", () => {
  for (const missing of REQUIRED_PRODUCTION_SECRETS) {
    const stub = JSON.stringify({
      id: "11111111-2222-4333-8444-555555555555",
      resources: {
        bindings: REQUIRED_PRODUCTION_SECRETS.filter((name) => name !== missing).map((name) => ({
          name,
          type: "secret_text",
        })),
      },
    });
    assert.throws(
      () => checkRollbackVersionSecrets(stub),
      (error) => {
        assert.match(error.message, /Rollback target version is missing/);
        assert.ok(error.message.includes(missing), `error must name ${missing}`);
        return true;
      },
    );
  }
});

for (const stub of [
  "",
  "not json",
  "[]",
  "{}",
  '{"resources":{}}',
  '{"resources":{"bindings":{}}}',
  '{"resources":{"bindings":[null]}}',
  '{"resources":{"bindings":[{}]}}',
  '{"resources":{"bindings":[{"name":"SESSION_SECRET"}]}}',
  '{"resources":{"bindings":[{"name":"","type":"secret_text"}]}}',
  '{"resources":{"bindings":[{"name":42,"type":"secret_text"}]}}',
  '{"resources":{"bindings":[{"type":"secret_text"}]}}',
]) {
  test(`malformed versions view output fails closed (${JSON.stringify(stub).slice(0, 60)})`, () => {
    assert.throws(
      () => checkRollbackVersionSecrets(stub),
      /Could not verify rollback target version secrets/,
    );
  });
}

test("non-secret bindings are ignored and value-like fields never surface", () => {
  const stub = JSON.stringify({
    id: "11111111-2222-4333-8444-555555555555",
    resources: {
      bindings: [
        { name: "SESSION_SECRET", type: "secret_text", value: "fixture-fake-aaa" },
        { name: "DISCORD_CLIENT_SECRET", type: "secret_text" },
        { name: "DISCORD_BOT_TOKEN", type: "secret_text" },
        { name: "DISCORD_GUILD_ID", type: "plain_text", text: "fixture-fake-bbb" },
        { name: "DB", type: "d1" },
      ],
    },
  });
  assert.deepEqual(checkRollbackVersionSecrets(stub), [...REQUIRED_PRODUCTION_SECRETS]);
  assert.throws(
    () =>
      checkRollbackVersionSecrets(
        JSON.stringify({
          id: "11111111-2222-4333-8444-555555555555",
          resources: {
            bindings: [{ name: "SESSION_SECRET", type: "secret_text" }],
          },
        }),
      ),
    (error) => {
      assert.ok(!error.message.includes("fixture-fake"), "error must never echo value-like fields");
      return true;
    },
  );
});

function cliWithStubbedWrangler(stubStdout, { exitCode = 0, stubStderr = "" } = {}) {
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "wrangler-stub-",
    ),
  );
  try {
    writeFileSync(
      join(scratch, "npx"),
      `#!${process.execPath}
import { writeSync } from "node:fs";
const expected = ["wrangler", "secret", "list", "--env", "production", "--format", "json"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  console.error("unexpected wrangler invocation: " + process.argv.slice(2).join(" "));
  process.exit(2);
}
if (process.env.STUB_STDERR) writeSync(2, process.env.STUB_STDERR);
writeSync(1, process.env.STUB_STDOUT);
process.exit(Number(process.env.STUB_EXIT));
`,
      { mode: 0o700 },
    );
    const result = spawnSync(process.execPath, ["ci/check-production-secrets.mjs"], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH}`,
        STUB_STDOUT: stubStdout,
        STUB_STDERR: stubStderr,
        STUB_EXIT: String(exitCode),
      },
    });
    assert.equal(result.error, undefined);
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("CLI passes with all secrets and prints names only, never wrangler output", () => {
  const result = cliWithStubbedWrangler(allPresent);
  assert.equal(result.status, 0);
  for (const name of REQUIRED_PRODUCTION_SECRETS) {
    assert.ok(result.stdout.includes(name), `stdout must list ${name}`);
  }
  assert.equal(result.stderr, "");
});

test("CLI fails closed on a missing secret and on wrangler failure without echoing output", () => {
  const missing = cliWithStubbedWrangler(JSON.stringify([{ name: "SESSION_SECRET" }]));
  assert.equal(missing.status, 1);
  assert.match(
    missing.stderr,
    /Missing production Worker secret.*DISCORD_CLIENT_SECRET.*DISCORD_BOT_TOKEN/,
  );
  assert.ok(
    !missing.stderr.includes("SESSION_SECRET") || missing.stderr.includes("Missing"),
    "stderr names only missing secrets",
  );
  assert.equal(missing.stdout, "");

  const failed = cliWithStubbedWrangler('{"error":"fixture denied"}', { exitCode: 1 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Could not verify production Worker secrets/);
  assert.ok(!failed.stderr.includes("fixture denied"), "wrangler output is never echoed");
  assert.equal(failed.stdout, "");
});

const ROLLBACK_VERSION_ID = "11111111-2222-4333-8444-555555555555";

function cliWithStubbedVersionsView(
  stubStdout,
  { exitCode = 0, versionId = ROLLBACK_VERSION_ID, stubStderr = "" } = {},
) {
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "wrangler-versions-stub-",
    ),
  );
  try {
    writeFileSync(
      join(scratch, "npx"),
      `#!${process.execPath}
import { writeSync } from "node:fs";
const expected = ["wrangler", "versions", "view", process.env.EXPECTED_VERSION, "--name", "two-web-next-production", "--json"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  console.error("unexpected wrangler invocation: " + process.argv.slice(2).join(" "));
  process.exit(2);
}
if (process.env.STUB_STDERR) writeSync(2, process.env.STUB_STDERR);
writeSync(1, process.env.STUB_STDOUT);
process.exit(Number(process.env.STUB_EXIT));
`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      ["ci/check-production-secrets.mjs", "--rollback-version"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${scratch}:${process.env.PATH}`,
          STUB_STDOUT: stubStdout,
          STUB_STDERR: stubStderr,
          STUB_EXIT: String(exitCode),
          EXPECTED_VERSION: versionId,
          ROLLBACK_VERSION_ID: versionId,
        },
      },
    );
    assert.equal(result.error, undefined);
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("rollback-version CLI passes on the target version and prints names only", () => {
  const result = cliWithStubbedVersionsView(versionAllPresent);
  assert.equal(result.status, 0);
  for (const name of REQUIRED_PRODUCTION_SECRETS) {
    assert.ok(result.stdout.includes(name), `stdout must list ${name}`);
  }
  assert.equal(result.stderr, "");
});

test("rollback-version CLI fails closed on a missing target secret and on bad input", () => {
  const missing = cliWithStubbedVersionsView(
    JSON.stringify({
      id: ROLLBACK_VERSION_ID,
      resources: { bindings: [{ name: "SESSION_SECRET", type: "secret_text" }] },
    }),
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Rollback target version is missing/);
  assert.equal(missing.stdout, "");

  const failed = cliWithStubbedVersionsView('{"error":"fixture denied"}', { exitCode: 1 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Could not verify rollback target version secrets/);
  assert.ok(!failed.stderr.includes("fixture denied"), "wrangler output is never echoed");
  assert.equal(failed.stdout, "");

  const badId = cliWithStubbedVersionsView(versionAllPresent, {
    versionId: "not-a-uuid; rm -rf /",
  });
  assert.equal(badId.status, 1);
  assert.match(badId.stderr, /ROLLBACK_VERSION_ID must be a Worker Version ID/);
  assert.equal(badId.stdout, "");
});

test("rollback-version CLI keeps child stderr out of both parent streams on success", () => {
  const canary = "synthetic-versions-view-stderr-canary-success";
  const result = cliWithStubbedVersionsView(versionAllPresent, {
    stubStderr: `${canary}\n`,
  });
  assert.equal(result.status, 0);
  for (const name of REQUIRED_PRODUCTION_SECRETS) {
    assert.ok(result.stdout.includes(name), `stdout must list ${name}`);
  }
  assert.ok(!result.stdout.includes('"name"'), "stdout must not forward the raw child JSON");
  assert.equal(result.stderr, "");
  assertNoChildCanary(result, canary);
});

test("rollback-version CLI keeps child stdout and stderr out of both parent streams on nonzero exit", () => {
  const stdoutCanary = "synthetic-versions-view-stdout-canary-nonzero";
  const stderrCanary = "synthetic-versions-view-stderr-canary-nonzero";
  const result = cliWithStubbedVersionsView(`${stdoutCanary}\n`, {
    exitCode: 42,
    stubStderr: `${stderrCanary}\n`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not verify rollback target version secrets/);
  assert.equal(result.stdout, "");
  assertNoChildCanary(result, stdoutCanary, stderrCanary);
});

// Child-stream boundary: the fake wrangler's stdout/stderr are untrusted
// input. Only validated required names and locally constructed diagnostics
// may reach the preflight's own stdout/stderr, on every outcome. Canaries
// are synthetic strings, never real values.
function assertNoChildCanary(result, ...canaries) {
  for (const canary of canaries) {
    assert.ok(
      !result.stdout.includes(canary),
      `parent stdout must not forward child output ${canary}`,
    );
    assert.ok(
      !result.stderr.includes(canary),
      `parent stderr must not forward child output ${canary}`,
    );
  }
}

test("CLI keeps child stderr out of both parent streams on success", () => {
  const canary = "synthetic-child-stderr-canary-success";
  const result = cliWithStubbedWrangler(allPresent, { stubStderr: `${canary}\n` });
  assert.equal(result.status, 0);
  for (const name of REQUIRED_PRODUCTION_SECRETS) {
    assert.ok(result.stdout.includes(name), `stdout must list ${name}`);
  }
  assert.ok(!result.stdout.includes('"name"'), "stdout must not forward the raw child JSON");
  assert.equal(result.stderr, "");
  assertNoChildCanary(result, canary);
});

test("CLI keeps child stdout and stderr out of both parent streams on nonzero exit", () => {
  const stdoutCanary = "synthetic-child-stdout-canary-nonzero";
  const stderrCanary = "synthetic-child-stderr-canary-nonzero";
  const result = cliWithStubbedWrangler(`${stdoutCanary}\n`, {
    exitCode: 42,
    stubStderr: `${stderrCanary}\n`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not verify production Worker secrets/);
  assert.equal(result.stdout, "");
  assertNoChildCanary(result, stdoutCanary, stderrCanary);
});

test("CLI keeps child stdout and stderr out of both parent streams on malformed JSON", () => {
  const stdoutCanary = "synthetic-child-stdout-canary-malformed";
  const stderrCanary = "synthetic-child-stderr-canary-malformed";
  const result = cliWithStubbedWrangler(`not json ${stdoutCanary}`, {
    stubStderr: `${stderrCanary}\n`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not verify production Worker secrets/);
  assert.equal(result.stdout, "");
  assertNoChildCanary(result, stdoutCanary, stderrCanary);
});

test("CLI keeps child stderr out of both parent streams when a required secret is missing", () => {
  const canary = "synthetic-child-stderr-canary-missing";
  const result = cliWithStubbedWrangler(JSON.stringify([{ name: "SESSION_SECRET" }]), {
    stubStderr: `${canary}\n`,
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Missing production Worker secret.*DISCORD_CLIENT_SECRET.*DISCORD_BOT_TOKEN/,
  );
  assert.equal(result.stdout, "");
  assertNoChildCanary(result, canary);
});

test("required-secrets preflight runs before the moderator preflight, version upload and gradual promotion", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const credentials = workflow.indexOf("run: node ci/production-deploy-gate.mjs --credentials");
  const secrets = workflow.indexOf("run: node ci/check-production-secrets.mjs");
  const moderator = workflow.indexOf("run: npm run check:worker-moderators-production");
  const upload = workflow.indexOf("npx wrangler versions upload --env production");
  const gradual = workflow.indexOf(
    "uses: TogetherWeOwn/.github/actions/gradual-promote@89c290be20c0044efaf6916f28341c76e75fff06",
  );
  assert.ok(
    credentials > 0 && secrets > 0 && moderator > 0 && upload > 0 && gradual > 0,
    "expected credentials, secrets, moderator, version upload and gradual promotion in deploy-production.yml",
  );
  assert.ok(
    credentials < secrets && secrets < moderator && moderator < upload && upload < gradual,
    "order must be credentials check, required-secrets preflight, moderator preflight, upload, gradual promotion",
  );
});

test("rollback target-version secrets preflight runs before wrangler rollback", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/rollback-production.yml", import.meta.url),
    "utf8",
  );
  const credentials = workflow.indexOf("run: node ci/production-deploy-gate.mjs --credentials");
  const targetSecrets = workflow.indexOf(
    "run: node ci/check-production-secrets.mjs --rollback-version",
  );
  const rollback = workflow.indexOf("npx wrangler rollback");
  assert.ok(
    credentials > 0 && targetSecrets > 0 && rollback > 0,
    "expected credentials, rollback target-version secrets and wrangler rollback in rollback-production.yml",
  );
  assert.ok(
    credentials < targetSecrets && targetSecrets < rollback,
    "order must be credentials check, rollback target-version secrets preflight, rollback",
  );
  // The rollback deploys the recorded version's own bindings, never the
  // dispatch SHA: latest-listing, moderator-config and dry-run build checks
  // validate the wrong artifact and must never gate the emergency path.
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
        `rollback must only check the target version, not the latest listing: ${line.trim()}`,
      );
    }
    if (line.trimStart().startsWith("run:") && line.includes("inputs.version_id")) {
      assert.fail(`input interpolates into a run: block: ${line}`);
    }
  }
  assert.match(workflow, /ROLLBACK_VERSION_ID: \$\{\{ inputs\.version_id \}\}/);
});

test("deploy-production.yml carries no wrangler rollback mutation (negative control)", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const secrets = workflow.indexOf("run: node ci/check-production-secrets.mjs");
  assert.ok(secrets > 0, "expected the required-secrets step in deploy-production.yml");
  assert.ok(
    !workflow.includes("npx wrangler rollback"),
    "deploy must not contain a wrangler rollback mutation",
  );
});

test("required-secrets preflight uses production-only credentials", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const at = workflow.indexOf("run: node ci/check-production-secrets.mjs");
  assert.ok(at > 0, "expected the required-secrets step in deploy-production.yml");
  const block = workflow.slice(at, at + 600);
  assert.ok(block.includes("secrets.PRODUCTION_CLOUDFLARE_API_TOKEN"));
  assert.ok(block.includes("secrets.PRODUCTION_CLOUDFLARE_ACCOUNT_ID"));
  assert.ok(
    !block.includes("secrets.CLOUDFLARE_API_TOKEN") ||
      block.includes("secrets.PRODUCTION_CLOUDFLARE_API_TOKEN"),
  );
  assert.ok(
    !/secrets\.(?!PRODUCTION_)CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)/.test(block),
    "secrets step must use production-only credentials",
  );
});

// ---------------------------------------------------------------------------
// Production secrets are Environment-scoped.
//
// A job can only read an Environment secret when it names the Environment, and
// GitHub's `secrets` context falls through to repo-level secrets, so a job
// that reads a PRODUCTION_* secret without binding the protected `production`
// Environment skips its required reviewers and main-only branch policy. Every
// reference is counted as written (comments included, since interpolation also
// runs inside shell comments), so a mention fails closed rather than being
// guessed at.
// ---------------------------------------------------------------------------

const PRODUCTION_SECRET = /\bsecrets\s*(?:\.\s*|\[\s*['"])PRODUCTION_/i;
// `inputs.target` selects the Environment; the secret is mapped only when it
// is exactly `production`, so a staging or scheduled run never receives it.
const GUARDED_PRODUCTION_SECRET =
  /\binputs\.target\s*==\s*'production'\s*&&\s*secrets\s*\.\s*PRODUCTION_/i;
// `inputs.target` alone, or with a literal fallback for scheduled runs.
const TARGET_ENVIRONMENT =
  /^\$\{\{\s*\(?\s*inputs\.target\s*(?:\|\|\s*'[A-Za-z-]+'\s*)?\)?\s*\}\}$/;

function stripQuotes(value) {
  return value
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
}

// Splits a workflow into the lines outside `jobs:` and one entry per job. The
// repo's workflows are block-style YAML with two-space indentation.
function splitWorkflow(text) {
  const outside = [];
  const jobs = [];
  let inJobs = false;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S/.test(line) && !line.startsWith("#")) inJobs = false;
    const job = inJobs ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
    if (job) jobs.push({ id: job[1], lines: [] });
    else if (inJobs && jobs.length > 0) jobs[jobs.length - 1].lines.push(line);
    else outside.push(line);
  }
  return { outside, jobs };
}

// The raw job-level `environment:` value: a name, an expression, or the
// `name:` of the block / flow-mapping form. Undefined when none is declared.
function jobEnvironment(lines) {
  const at = lines.findIndex((line) => /^ {4}environment:/.test(line));
  if (at < 0) return undefined;
  const inline = lines[at].replace(/^ {4}environment:/, "").trim();
  if (inline !== "") {
    const flow = /^\{.*\bname:\s*([^,}]+)/.exec(inline);
    return stripQuotes(flow ? flow[1] : inline);
  }
  for (const line of lines.slice(at + 1)) {
    if (/^ {0,4}\S/.test(line)) break;
    const name = /^ {6}name:\s*(.+)$/.exec(line);
    if (name) return stripQuotes(name[1]);
  }
  return undefined;
}

export function productionSecretEnvironmentViolations(text, file) {
  const { outside, jobs } = splitWorkflow(text);
  const violations = [];
  if (outside.some((line) => PRODUCTION_SECRET.test(line))) {
    violations.push(
      `${file}: PRODUCTION_* secret referenced outside a job, where no environment can be bound`,
    );
  }
  for (const { id, lines } of jobs) {
    const referencing = lines.filter((line) => PRODUCTION_SECRET.test(line));
    if (referencing.length === 0) continue;
    const environment = jobEnvironment(lines);
    if (environment === undefined) {
      violations.push(`${file}: job ${id} reads a PRODUCTION_* secret without an environment`);
    } else if (/^production$/i.test(environment)) {
      // Bound to the protected Environment on every run.
    } else if (TARGET_ENVIRONMENT.test(environment)) {
      for (const line of referencing) {
        if (!GUARDED_PRODUCTION_SECRET.test(line)) {
          violations.push(
            `${file}: job ${id} maps a PRODUCTION_* secret without guarding it on inputs.target == 'production'`,
          );
          break;
        }
      }
    } else {
      violations.push(
        `${file}: job ${id} reads a PRODUCTION_* secret but binds environment ${environment}, not production`,
      );
    }
  }
  return violations;
}

const WORKFLOWS = new URL("../.github/workflows/", import.meta.url);

test("every job that reads a PRODUCTION_* secret binds the production environment", () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, "expected workflows under .github/workflows");
  const referencing = [];
  const violations = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, WORKFLOWS), "utf8");
    if (PRODUCTION_SECRET.test(text)) referencing.push(file);
    violations.push(...productionSecretEnvironmentViolations(text, file));
  }
  // Composite actions cannot bind an Environment, so they must never read a
  // PRODUCTION_* secret themselves: the environment-bound caller passes
  // values in as inputs. Any direct reference fails closed here.
  const ACTIONS = new URL("../.github/actions/", import.meta.url);
  for (const entry of readdirSync(ACTIONS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = `${entry.name}/action.yml`;
    const text = readFileSync(new URL(file, ACTIONS), "utf8");
    if (PRODUCTION_SECRET.test(text)) {
      violations.push(
        `${file}: PRODUCTION_* secret referenced in a composite action, which cannot bind an environment`,
      );
    }
  }
  // The scan is only meaningful if it sees the workflows that carry the secrets.
  for (const expected of [
    "deploy-production.yml",
    "rollback-production.yml",
    "db-migrate.yml",
    "db-backup.yml",
  ]) {
    assert.ok(referencing.includes(expected), `expected ${expected} to reference PRODUCTION_*`);
  }
  assert.deepEqual(violations, []);
});

test("db-backup selects its environment from the dispatch target, staging by default", () => {
  const { jobs } = splitWorkflow(readFileSync(new URL("db-backup.yml", WORKFLOWS), "utf8"));
  const backup = jobs.find((job) => job.id === "backup");
  assert.ok(backup, "expected a backup job");
  // Scheduled runs carry no inputs, so they fall back to staging.
  assert.equal(jobEnvironment(backup.lines), "${{ inputs.target || 'staging' }}");
});

// ---------------------------------------------------------------------------
// Backup docs pin to the implementation.
//
// docs/db-migrations.md "Backups" and the db-backup.yml header must state the
// real schedule (staging nightly; production manual dispatch only) and the real
// R2 key layout from bin/db-backup.sh prefix() / manifest_key(). No workflow
// or script behavior changes here.
// ---------------------------------------------------------------------------

test("db-backup schedule dumps staging; production is manual dispatch only", () => {
  const workflow = readFileSync(new URL("db-backup.yml", WORKFLOWS), "utf8");
  // The 03:17Z schedule carries no inputs, so `inputs.target || 'staging'`
  // resolves to staging; production needs a manual dispatch with a target.
  assert.ok(workflow.includes("17 3 * * *"), "expected the 03:17Z cron in db-backup.yml");
  assert.ok(
    workflow.includes("environment: ${{ inputs.target || 'staging' }}"),
    "schedule path must resolve to staging via the inputs.target fallback",
  );
  assert.ok(
    workflow.includes('default: "staging"'),
    "expected the dispatch target to default to staging",
  );

  const header = workflow.slice(0, workflow.indexOf("on:"));
  assert.ok(
    header.includes("Staging is dumped nightly by the schedule"),
    "workflow header must state staging is dumped nightly by the schedule",
  );
  assert.ok(
    header.includes("target: production"),
    "workflow header must state production is dumped only by manual dispatch",
  );
  assert.ok(
    header.includes("`production` Environment"),
    "workflow header must name the production Environment gate",
  );

  const docs = readFileSync(new URL("../docs/db-migrations.md", import.meta.url), "utf8");
  const start = docs.indexOf("## Backups");
  assert.ok(start >= 0, "expected a Backups section in docs/db-migrations.md");
  const end = docs.indexOf("## ", start + "## ".length);
  const backups = docs.slice(start, end < 0 ? undefined : end);
  assert.ok(
    backups.includes("Staging is dumped nightly by the schedule") ||
      backups.includes("Staging is\n dumped nightly by the schedule") ||
      backups.includes("dumped nightly by the schedule"),
    "Backups section must state staging is dumped nightly by the schedule",
  );
  assert.ok(
    backups.includes("only by manual dispatch"),
    "Backups section must state production is dumped only by manual dispatch",
  );
  assert.ok(
    backups.includes("target: production"),
    "Backups section must name the manual dispatch target: production",
  );
  assert.ok(
    backups.includes("`production` Environment"),
    "Backups section must name the production Environment gate",
  );
  // The promote-weekly + rotate step runs on scheduled runs only, so the
  // docs must scope 7+4 retention to scheduled runs and say a production
  // dispatch only backs up and checks.
  assert.ok(
    workflow.includes("github.event.schedule != ''"),
    "promote-weekly + rotate must run on scheduled runs only",
  );
  assert.ok(
    backups.includes("Retention on scheduled runs"),
    "Backups section must scope 7+4 retention to scheduled runs",
  );
  assert.ok(
    backups.includes("only backs up and checks"),
    "Backups section must state a production dispatch only backs up and checks",
  );

  const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8");
  assert.ok(
    runbook.includes("Retention on the scheduled staging run"),
    "runbook must scope 7+4 retention to the scheduled staging run",
  );
});

test("backup docs name the real R2 key layout from prefix() / manifest_key()", () => {
  const script = readFileSync(new URL("../bin/db-backup.sh", import.meta.url), "utf8");
  assert.match(
    script,
    /prefix\(\) \{ printf '%s\/%s-%s'/,
    "expected prefix() to build <prefix>/<branch>-<branch> in bin/db-backup.sh",
  );
  assert.match(
    script,
    /manifest_key\(\) \{ printf '%s\/%s-%s\/MANIFEST\.txt'/,
    "expected manifest_key() to build <prefix>/<branch>-<branch>/MANIFEST.txt",
  );

  const docs = readFileSync(new URL("../docs/db-migrations.md", import.meta.url), "utf8");
  const start = docs.indexOf("## Backups");
  assert.ok(start >= 0, "expected a Backups section in docs/db-migrations.md");
  const end = docs.indexOf("## ", start + "## ".length);
  const backups = docs.slice(start, end < 0 ? undefined : end);
  assert.ok(
    backups.includes("neon/<branch>-<branch>-<UTC>.dump"),
    "Backups layout must name the real daily key neon/<branch>-<branch>-<UTC>.dump",
  );
  assert.ok(
    backups.includes("neon/<branch>-<branch>/MANIFEST.txt"),
    "Backups layout must name the real manifest neon/<branch>-<branch>/MANIFEST.txt",
  );
  assert.ok(
    !backups.includes("neon-staging/neon-") && !backups.includes("neon-production/neon-"),
    "Backups layout must not use the old neon-staging/neon- prefix",
  );

  const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8");
  assert.ok(
    !runbook.includes("older examples in `docs/db-migrations.md`"),
    "runbook must not carry the older-examples caveat once the docs agree",
  );
  assert.ok(
    runbook.includes("neon/staging-staging/MANIFEST.txt"),
    "runbook must keep the staging manifest example",
  );
});

// Fixtures mirror the shapes that matter; none contain a real value.
const FIXTURE_HEAD = `name: fixture
on:
  workflow_dispatch:
    inputs:
      target:
        type: choice
        options: [staging, production]
`;

test("production secret in a job with no environment is a violation (the pre-fix db-backup shape)", () => {
  const text = `${FIXTURE_HEAD}jobs:
  backup:
    runs-on: ubuntu-latest
    env:
      TARGET: \${{ inputs.target || 'staging' }}
    steps:
      - id: probe
        env:
          PRODUCTION_URL: \${{ secrets.PRODUCTION_DATABASE_URL }}
        run: true
`;
  assert.deepEqual(productionSecretEnvironmentViolations(text, "fixture.yml"), [
    "fixture.yml: job backup reads a PRODUCTION_* secret without an environment",
  ]);
});

test("production secret under a non-production environment is a violation", () => {
  for (const environment of ["staging", "name: staging", "{ name: staging, url: https://x }"]) {
    const block = environment.startsWith("name:")
      ? `    environment:\n      ${environment}`
      : `    environment: ${environment}`;
    const text = `${FIXTURE_HEAD}jobs:
  backup:
    runs-on: ubuntu-latest
${block}
    steps:
      - env:
          X: \${{ secrets.PRODUCTION_DATABASE_URL }}
        run: true
`;
    const violations = productionSecretEnvironmentViolations(text, "fixture.yml");
    assert.equal(violations.length, 1, environment);
    assert.match(violations[0], /binds environment staging, not production/);
  }
});

test("production secret outside any job, or via bracket syntax, is a violation", () => {
  const outside = `${FIXTURE_HEAD}env:
  X: \${{ secrets.PRODUCTION_DATABASE_URL }}
jobs:
  backup:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: true
`;
  assert.deepEqual(productionSecretEnvironmentViolations(outside, "fixture.yml"), [
    "fixture.yml: PRODUCTION_* secret referenced outside a job, where no environment can be bound",
  ]);
  const bracket = `${FIXTURE_HEAD}jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - env:
          X: \${{ secrets['production_database_url'] }}
        run: true
`;
  // Secret names are case-insensitive, so a lowercase spelling is still a read.
  assert.equal(productionSecretEnvironmentViolations(bracket, "fixture.yml").length, 1);
  const bracketUpper = bracket.replace("production_database_url", "PRODUCTION_DATABASE_URL");
  assert.equal(productionSecretEnvironmentViolations(bracketUpper, "fixture.yml").length, 1);
});

test("production environment forms (name, block, flow mapping, quoted) all pass", () => {
  for (const block of [
    "    environment: production",
    "    environment: 'production'",
    '    environment: "production"',
    "    environment:\n      name: production\n      url: https://togetherweown.com",
    "    environment: { name: production, url: https://togetherweown.com }",
  ]) {
    const text = `${FIXTURE_HEAD}jobs:
  deploy:
    runs-on: ubuntu-latest
${block}
    steps:
      - env:
          X: \${{ secrets.PRODUCTION_CLOUDFLARE_API_TOKEN }}
        run: true
`;
    assert.deepEqual(productionSecretEnvironmentViolations(text, "fixture.yml"), [], block);
  }
});

test("target-selected environment requires every mapping to be guarded on inputs.target", () => {
  const guarded = `${FIXTURE_HEAD}jobs:
  migrate:
    runs-on: ubuntu-latest
    environment: \${{ inputs.target || 'staging' }}
    steps:
      - env:
          URL: \${{ inputs.target == 'production' && secrets.PRODUCTION_DATABASE_URL || '' }}
        run: true
`;
  assert.deepEqual(productionSecretEnvironmentViolations(guarded, "fixture.yml"), []);
  const unguarded = guarded.replace("inputs.target == 'production' && ", "");
  assert.equal(productionSecretEnvironmentViolations(unguarded, "fixture.yml").length, 1);
  // A guard on something other than the input that selects the Environment
  // does not count: it could be true while the job is bound to staging.
  const wrongGuard = guarded.replace("inputs.target == 'production'", "env.TARGET == 'production'");
  assert.equal(productionSecretEnvironmentViolations(wrongGuard, "fixture.yml").length, 1);
  // An expression that cannot be shown to select production is rejected.
  const opaque = guarded.replace("inputs.target || 'staging'", "vars.ENVIRONMENT_NAME");
  assert.equal(productionSecretEnvironmentViolations(opaque, "fixture.yml").length, 1);
});

// ---------------------------------------------------------------------------
// Staging Cloudflare secrets are Environment-scoped too.
//
// The unprefixed CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID names belong to
// the `staging` Environment, the same way the PRODUCTION_* names belong to
// `production`. A job that reads them without binding an Environment falls
// through to repository scope and skips the Environment's main-only branch
// policy, so every reference must come from a job bound to `staging` — or,
// for a target-selected Environment, from a mapping that hands production
// runs the PRODUCTION_* pair behind the inputs.target guard and hands the
// staging name only to non-production runs. The staging branch must carry
// its own `inputs.target != 'production'` guard: in a bare
// `prod && secret || staging-secret` chain an empty production secret is
// falsy, so a production run would silently fall back to the staging name.
// Comments count as written, as above.
// ---------------------------------------------------------------------------

const STAGING_CLOUDFLARE_SECRET =
  /\bsecrets\s*(?:\.\s*|\[\s*['"])CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)\b/i;
// The production name is taken only under the same input that selects the
// production Environment, and the staging name only under the inverse
// guard, so an empty production secret resolves to '' (a loud downstream
// auth failure), never to the staging credential.
const TARGET_GUARDED_STAGING_CLOUDFLARE =
  /\binputs\.target\s*==\s*'production'\s*&&\s*secrets\s*\.\s*PRODUCTION_CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)\s*\|\|\s*inputs\.target\s*!=\s*'production'\s*&&\s*secrets\s*\.\s*CLOUDFLARE_\1\s*\|\|\s*''/i;

export function stagingCloudflareEnvironmentViolations(text, file) {
  const { outside, jobs } = splitWorkflow(text);
  const violations = [];
  if (outside.some((line) => STAGING_CLOUDFLARE_SECRET.test(line))) {
    violations.push(
      `${file}: staging Cloudflare secret referenced outside a job, where no environment can be bound`,
    );
  }
  for (const { id, lines } of jobs) {
    const referencing = lines.filter((line) => STAGING_CLOUDFLARE_SECRET.test(line));
    if (referencing.length === 0) continue;
    const environment = jobEnvironment(lines);
    if (environment === undefined) {
      violations.push(
        `${file}: job ${id} reads a staging Cloudflare secret without an environment`,
      );
    } else if (/^staging$/i.test(environment)) {
      // Bound to the staging Environment on every run.
    } else if (TARGET_ENVIRONMENT.test(environment)) {
      for (const line of referencing) {
        if (!TARGET_GUARDED_STAGING_CLOUDFLARE.test(line)) {
          violations.push(
            `${file}: job ${id} maps a staging Cloudflare secret without the inputs.target == 'production' guard to its PRODUCTION_* pair`,
          );
          break;
        }
      }
    } else {
      violations.push(
        `${file}: job ${id} reads a staging Cloudflare secret but binds environment ${environment}, not staging`,
      );
    }
  }
  return violations;
}

test("every job that reads a staging Cloudflare secret binds the staging environment", () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, "expected workflows under .github/workflows");
  const referencing = [];
  const violations = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, WORKFLOWS), "utf8");
    if (STAGING_CLOUDFLARE_SECRET.test(text)) referencing.push(file);
    violations.push(...stagingCloudflareEnvironmentViolations(text, file));
  }
  // Composite actions cannot bind an Environment: the environment-bound
  // caller passes the credentials in as inputs, never a direct read.
  const ACTIONS = new URL("../.github/actions/", import.meta.url);
  for (const entry of readdirSync(ACTIONS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = `${entry.name}/action.yml`;
    const text = readFileSync(new URL(file, ACTIONS), "utf8");
    if (STAGING_CLOUDFLARE_SECRET.test(text)) {
      violations.push(
        `${file}: staging Cloudflare secret referenced in a composite action, which cannot bind an environment`,
      );
    }
  }
  // The scan is only meaningful if it sees the workflows that carry the secrets.
  for (const expected of [
    "deploy.yml",
    "gradual-promote-proof.yml",
    "error-rate-gate-rehearsal.yml",
    "db-backup.yml",
  ]) {
    assert.ok(
      referencing.includes(expected),
      `expected ${expected} to reference a staging Cloudflare secret`,
    );
  }
  assert.deepEqual(violations, []);
});

test("staging Cloudflare secret in a job with no environment is a violation", () => {
  const text = `${FIXTURE_HEAD}jobs:
  rehearsal:
    runs-on: ubuntu-latest
    steps:
      - env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: true
`;
  assert.deepEqual(stagingCloudflareEnvironmentViolations(text, "fixture.yml"), [
    "fixture.yml: job rehearsal reads a staging Cloudflare secret without an environment",
  ]);
});

test("staging Cloudflare secret under a non-staging environment is a violation", () => {
  for (const environment of ["production", "name: production", "{ name: qa, url: https://x }"]) {
    const block = environment.startsWith("name:")
      ? `    environment:\n      ${environment}`
      : `    environment: ${environment}`;
    const text = `${FIXTURE_HEAD}jobs:
  rehearsal:
    runs-on: ubuntu-latest
${block}
    steps:
      - env:
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: true
`;
    const violations = stagingCloudflareEnvironmentViolations(text, "fixture.yml");
    assert.equal(violations.length, 1, environment);
    assert.match(violations[0], /not staging/);
  }
});

test("staging environment forms (name, block, flow mapping, quoted) all pass", () => {
  for (const block of [
    "    environment: staging",
    "    environment: 'staging'",
    '    environment: "staging"',
    "    environment:\n      name: staging\n      url: https://next.togetherweown.com",
    "    environment: { name: staging, url: https://next.togetherweown.com }",
  ]) {
    const text = `${FIXTURE_HEAD}jobs:
  rehearsal:
    runs-on: ubuntu-latest
${block}
    steps:
      - env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: true
`;
    assert.deepEqual(stagingCloudflareEnvironmentViolations(text, "fixture.yml"), [], block);
  }
});

test("staging Cloudflare secret outside any job, or via bracket syntax, is a violation", () => {
  const outside = `${FIXTURE_HEAD}env:
  X: \${{ secrets.CLOUDFLARE_API_TOKEN }}
jobs:
  rehearsal:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - run: true
`;
  assert.deepEqual(stagingCloudflareEnvironmentViolations(outside, "fixture.yml"), [
    "fixture.yml: staging Cloudflare secret referenced outside a job, where no environment can be bound",
  ]);
  const bracket = `${FIXTURE_HEAD}jobs:
  rehearsal:
    runs-on: ubuntu-latest
    steps:
      - env:
          X: \${{ secrets['cloudflare_api_token'] }}
        run: true
`;
  // Secret names are case-insensitive, so a lowercase spelling is still a read.
  assert.equal(stagingCloudflareEnvironmentViolations(bracket, "fixture.yml").length, 1);
});

test("target-selected environment requires the PRODUCTION_* guard for staging Cloudflare names", () => {
  const guarded = `${FIXTURE_HEAD}jobs:
  backup:
    runs-on: ubuntu-latest
    environment: \${{ inputs.target || 'staging' }}
    steps:
      - env:
          CLOUDFLARE_API_TOKEN: \${{ inputs.target == 'production' && secrets.PRODUCTION_CLOUDFLARE_API_TOKEN || inputs.target != 'production' && secrets.CLOUDFLARE_API_TOKEN || '' }}
          CLOUDFLARE_ACCOUNT_ID: \${{ inputs.target == 'production' && secrets.PRODUCTION_CLOUDFLARE_ACCOUNT_ID || inputs.target != 'production' && secrets.CLOUDFLARE_ACCOUNT_ID || '' }}
        run: true
`;
  assert.deepEqual(stagingCloudflareEnvironmentViolations(guarded, "fixture.yml"), []);
  const unguarded = guarded.replace(
    "inputs.target == 'production' && secrets.PRODUCTION_CLOUDFLARE_API_TOKEN || ",
    "",
  );
  assert.equal(stagingCloudflareEnvironmentViolations(unguarded, "fixture.yml").length, 1);
  // A bare `prod && secret || staging-secret` chain is a violation: an empty
  // production secret is falsy, so a production run would fall back to the
  // staging credential instead of resolving to ''.
  const bareFallback = guarded.replace(
    "|| inputs.target != 'production' && secrets.CLOUDFLARE_API_TOKEN || ''",
    "|| secrets.CLOUDFLARE_API_TOKEN",
  );
  assert.equal(stagingCloudflareEnvironmentViolations(bareFallback, "fixture.yml").length, 1);
  // The guard must pair each staging name with its own PRODUCTION_* twin.
  const mismatched = guarded.replace(
    "secrets.PRODUCTION_CLOUDFLARE_API_TOKEN || inputs.target != 'production' && secrets.CLOUDFLARE_API_TOKEN",
    "secrets.PRODUCTION_CLOUDFLARE_ACCOUNT_ID || inputs.target != 'production' && secrets.CLOUDFLARE_API_TOKEN",
  );
  assert.equal(stagingCloudflareEnvironmentViolations(mismatched, "fixture.yml").length, 1);
  // An expression that cannot be shown to select staging is rejected.
  const opaque = guarded.replace("inputs.target || 'staging'", "vars.ENVIRONMENT_NAME");
  assert.equal(stagingCloudflareEnvironmentViolations(opaque, "fixture.yml").length, 1);
});

// ---------------------------------------------------------------------------
// Production secret set pins to Env.
//
// REQUIRED_PRODUCTION_SECRETS must equal the required (non-optional) secret
// fields of `Env` in src/env.ts. "Secret" here means the name carries
// SECRET or TOKEN: today that is DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN and
// SESSION_SECRET. Public required config (APP_URL, DISCORD_CLIENT_ID,
// DISCORD_GUILD_ID, DISCORD_INVITE_URL) never matches and stays out.
// Optional SECRET/TOKEN fields (QA_AUTH_TOKEN, SOURCE_EVIDENCE_VERIFIER_TOKEN,
// BOT_SHARED_SECRET via AgentEventsEnv) stay out until made required.
// BOT_ENDPOINT_URL, BOT_KEY_ID and BOT_SHARED_SECRET are read from Env by the
// deployed web/jobs paths, but they stay optional there and every reader
// fails closed when they are missing — so they stay out of the required set,
// covered by the same-change note in check-production-secrets.mjs pinned
// below. If any of them is ever made required, it joins the gate set in the
// same change.
// ---------------------------------------------------------------------------

const ENV_SECRET_NAME = /(SECRET|TOKEN)/;

function extractTypeBlockRange(source, typeName) {
  const decl = new RegExp(`\\btype\\s+${typeName}\\b`).exec(source);
  assert.ok(decl, `expected type ${typeName}`);
  const start = source.indexOf("{", decl.index);
  assert.ok(start >= 0, `expected body for type ${typeName}`);
  let depth = 0;
  let single = false;
  let double = false;
  let backtick = false;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (single) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "'") single = false;
      continue;
    }
    if (double) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') double = false;
      continue;
    }
    if (backtick) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "`") backtick = false;
      continue;
    }
    if (c === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (c === "'") {
      single = true;
      continue;
    }
    if (c === '"') {
      double = true;
      continue;
    }
    if (c === "`") {
      backtick = true;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return { block: source.slice(start, i + 1), end: i };
    }
  }
  throw new Error(`Unterminated ${typeName} body`);
}

function extractTypeBlock(source, typeName) {
  return extractTypeBlockRange(source, typeName).block;
}

// Env must stay `AgentEventsEnv & {...};` on one line, and AgentEventsEnv
// must stay `= {...};`. A new intersection half before the body (or Omit<...>)
// or after it (`} & PayEnv`) would otherwise pass silently while Env requires
// names the gate never checks, which is exactly the drift this pin exists to
// catch.
function assertClosedWithSemicolon(source, typeName) {
  const { end } = extractTypeBlockRange(source, typeName);
  const tail = stripCommentsAndStrings(source.slice(end + 1)).trimStart();
  assert.ok(
    tail.startsWith(";"),
    `${typeName} must end with \`};\`: a type joined after the body needs parser + pin support`,
  );
}

function assertEnvIntersectionShape(source) {
  const agentDecl = /\btype\s+AgentEventsEnv\s*=\s*([^{\n]*)\{/.exec(source);
  assert.ok(agentDecl, "expected an AgentEventsEnv header");
  assert.equal(
    agentDecl[1].trim(),
    "",
    "AgentEventsEnv must stay `= {...}`: a new intersection half needs parser + pin support",
  );
  const decl = /\btype\s+Env\s*=\s*([^\n{]*)\{/.exec(source);
  assert.ok(decl, "expected an Env intersection header");
  assert.equal(
    decl[1].trim(),
    "AgentEventsEnv &",
    "Env must stay `AgentEventsEnv & {...}`: a new intersection half needs parser + pin support",
  );
  assertClosedWithSemicolon(source, "AgentEventsEnv");
  assertClosedWithSemicolon(source, "Env");
}

// Blank comments and string literals (braces included) so field matching
// never reads comment text like `// OLD_TOKEN: removed` or a `"..."` value.
function stripCommentsAndStrings(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (c === "\n") {
        lineComment = false;
        out += c;
      } else {
        out += " ";
      }
      i++;
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (quote) {
      out += c === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      lineComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      blockComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Fields at the top level of a stripped type body only (brace depth 1), so a
// required key inside a nested object literal never counts as an Env secret.
function topLevelFields(stripped) {
  const depthAt = new Array(stripped.length);
  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    depthAt[i] = depth;
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") depth--;
  }
  const fields = [];
  const field = /\b([A-Z][A-Z0-9_]*)\s*(\?)?\s*:/g;
  let match;
  while ((match = field.exec(stripped)) !== null) {
    if (depthAt[match.index] !== 1) continue;
    fields.push({ name: match[1], optional: match[2] === "?" });
  }
  return fields;
}

export function requiredEnvSecretNames(source) {
  // Env is `AgentEventsEnv & {...}`: both halves contribute required keys.
  // JobsEnv is deliberately out of scope: it belongs to the jobs Worker.
  assertEnvIntersectionShape(source);
  const blocks = [extractTypeBlock(source, "AgentEventsEnv"), extractTypeBlock(source, "Env")];
  const names = new Set();
  for (const block of blocks) {
    for (const { name, optional } of topLevelFields(stripCommentsAndStrings(block))) {
      if (optional) continue;
      if (!ENV_SECRET_NAME.test(name)) continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

const FIXTURE_ENV_BASE = `export type AgentEventsEnv = {
  BOT_ENDPOINT_URL?: string;
  BOT_KEY_ID?: string;
  BOT_SHARED_SECRET?: string;
};
export type Env = AgentEventsEnv & {
  APP_URL: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  SESSION_SECRET: string;
};
`;

test("REQUIRED_PRODUCTION_SECRETS equals the required secret fields of Env", () => {
  const source = readFileSync(new URL("../src/env.ts", import.meta.url), "utf8");
  assert.deepEqual([...REQUIRED_PRODUCTION_SECRETS].sort(), requiredEnvSecretNames(source));
});

test("fixture Env round-trip: new required secret diverges until the gate set is updated", () => {
  assert.deepEqual(requiredEnvSecretNames(FIXTURE_ENV_BASE), [
    "DISCORD_BOT_TOKEN",
    "DISCORD_CLIENT_SECRET",
    "SESSION_SECRET",
  ]);
  const withDummy = FIXTURE_ENV_BASE.replace(
    "SESSION_SECRET: string;",
    "SESSION_SECRET: string;\n  DUMMY_REQUIRED_SECRET: string;",
  );
  const extracted = requiredEnvSecretNames(withDummy);
  assert.ok(extracted.includes("DUMMY_REQUIRED_SECRET"), "extraction must see the dummy secret");
  assert.notDeepEqual(
    [...REQUIRED_PRODUCTION_SECRETS].sort(),
    extracted,
    "a new required Env secret must fail the pin",
  );
  assert.deepEqual(
    [...REQUIRED_PRODUCTION_SECRETS, "DUMMY_REQUIRED_SECRET"].sort(),
    extracted,
    "updating the gate set to include it must pass",
  );
});

test("fixture Env ignores comments, strings and nested type keys", () => {
  const withNoise = FIXTURE_ENV_BASE.replace(
    "SESSION_SECRET: string;",
    `SESSION_SECRET: string;
  // OLD_TOKEN: removed, must never count as a required secret
  /* MULTI_SECRET: still a comment, must never count */
  NESTED?: { FOO_TOKEN: string; inner: { BAR_SECRET: string } };
  NESTED_REQUIRED: { BAZ_TOKEN: string };
  NOTE: "see QUX_TOKEN in the manual";`,
  );
  assert.deepEqual(
    requiredEnvSecretNames(withNoise),
    requiredEnvSecretNames(FIXTURE_ENV_BASE),
    "comments, string literals and nested keys must not change the pin",
  );
});

test("fixture Env intersection shape change fails closed", () => {
  const withHalf = FIXTURE_ENV_BASE.replace(
    "export type Env = AgentEventsEnv & {",
    "export type Env = AgentEventsEnv & PayEnv & {",
  );
  assert.throws(
    () => requiredEnvSecretNames(withHalf),
    /AgentEventsEnv &/,
    "a new Env intersection half must fail the pin until the parser supports it",
  );
  const withSuffix =
    FIXTURE_ENV_BASE.replace(
      "  SESSION_SECRET: string;\n};",
      "  SESSION_SECRET: string;\n} & PayEnv;",
    ) + "export type PayEnv = { PAY_SECRET: string };\n";
  assert.throws(
    () => requiredEnvSecretNames(withSuffix),
    /needs parser \+ pin support/,
    "a type joined after the Env body must fail the pin until the parser supports it",
  );
  const withAgentHalf = FIXTURE_ENV_BASE.replace(
    "export type AgentEventsEnv = {",
    "export type AgentEventsEnv = BaseEnv & {",
  );
  assert.throws(
    () => requiredEnvSecretNames(withAgentHalf),
    /= \{\.\.\.\}/,
    "a new AgentEventsEnv intersection half must fail the pin until the parser supports it",
  );
});

test("fixture Env keeps optional secrets and public config out of the pin", () => {
  const withOptional = FIXTURE_ENV_BASE.replace(
    "SESSION_SECRET: string;",
    "SESSION_SECRET: string;\n  DUMMY_OPTIONAL_SECRET?: string;",
  );
  assert.deepEqual(
    requiredEnvSecretNames(withOptional),
    requiredEnvSecretNames(FIXTURE_ENV_BASE),
    "an optional SECRET field must not change the pin",
  );
  const extracted = requiredEnvSecretNames(FIXTURE_ENV_BASE);
  assert.ok(!extracted.includes("APP_URL"), "public required config stays out");
  for (const name of ["BOT_ENDPOINT_URL", "BOT_KEY_ID", "BOT_SHARED_SECRET"]) {
    assert.ok(!extracted.includes(name), `${name} stays out while optional`);
    assert.ok(!REQUIRED_PRODUCTION_SECRETS.includes(name), `${name} stays out of the gate set`);
  }
  const real = readFileSync(new URL("../src/env.ts", import.meta.url), "utf8");
  for (const name of ["BOT_ENDPOINT_URL", "BOT_SHARED_SECRET", "BOT_KEY_ID"]) {
    assert.match(real, new RegExp(`${name}\\s*\\?:`), `${name} must stay optional in Env`);
  }
});

test("gate keeps the BOT_* same-change note", () => {
  const gate = readFileSync(new URL("./check-production-secrets.mjs", import.meta.url), "utf8");
  assert.ok(gate.includes("BOT_ENDPOINT_URL"), "gate must still name BOT_ENDPOINT_URL");
  assert.ok(gate.includes("BOT_SHARED_SECRET"), "gate must still name BOT_SHARED_SECRET");
  assert.ok(gate.includes("BOT_KEY_ID"), "gate must still name BOT_KEY_ID");
  assert.ok(
    gate.includes("If any of them is ever made required"),
    "gate must keep the same-change note",
  );
});
