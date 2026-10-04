import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  REQUIRED_PRODUCTION_SECRETS,
  checkProductionSecrets,
  missingRequiredSecrets,
  parseSecretNames,
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

function cliWithStubbedWrangler(stubStdout, { exitCode = 0 } = {}) {
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
import { writeFileSync } from "node:fs";
const expected = ["wrangler", "secret", "list", "--env", "production", "--format", "json"];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
  console.error("unexpected wrangler invocation: " + process.argv.slice(2).join(" "));
  process.exit(2);
}
process.stdout.write(process.env.STUB_STDOUT);
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

test("required-secrets preflight runs after the credentials check and before the moderator preflight and deploy", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-production.yml", import.meta.url),
    "utf8",
  );
  const credentials = workflow.indexOf("run: node ci/production-deploy-gate.mjs --credentials");
  const secrets = workflow.indexOf("run: node ci/check-production-secrets.mjs");
  const moderator = workflow.indexOf("run: npm run check:worker-moderators-production");
  const deploy = workflow.indexOf("run: npx wrangler deploy --env production");
  assert.ok(
    credentials > 0 && secrets > 0 && moderator > 0 && deploy > 0,
    "expected credentials, secrets, moderator and deploy steps in deploy-production.yml",
  );
  assert.ok(
    credentials < secrets && secrets < moderator && moderator < deploy,
    "order must be credentials check, required-secrets preflight, moderator preflight, deploy",
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
  // The scan is only meaningful if it sees the workflows that carry the secrets.
  for (const expected of [
    "deploy-production.yml",
    "rollback-production.yml",
    "db-migrate.yml",
    "neon-backup.yml",
  ]) {
    assert.ok(referencing.includes(expected), `expected ${expected} to reference PRODUCTION_*`);
  }
  assert.deepEqual(violations, []);
});

test("neon-backup selects its environment from the dispatch target, staging by default", () => {
  const { jobs } = splitWorkflow(readFileSync(new URL("neon-backup.yml", WORKFLOWS), "utf8"));
  const backup = jobs.find((job) => job.id === "backup");
  assert.ok(backup, "expected a backup job");
  // Scheduled runs carry no inputs, so they fall back to staging.
  assert.equal(jobEnvironment(backup.lines), "${{ inputs.target || 'staging' }}");
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

test("production secret in a job with no environment is a violation (the pre-fix neon-backup shape)", () => {
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
