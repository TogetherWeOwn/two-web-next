import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  REQUIRED_JOBS_SECRETS,
  checkJobsSecrets,
  missingRequiredSecrets,
  parseEnv,
  parseSecretNames,
  secretListArgs,
} from "./check-jobs-secrets.mjs";

const allPresent = JSON.stringify([
  { name: "BOT_ENDPOINT_URL" },
  { name: "BOT_KEY_ID" },
  { name: "BOT_SHARED_SECRET" },
]);

test("all required secrets present passes and returns the required names", () => {
  assert.deepEqual(checkJobsSecrets(allPresent), [...REQUIRED_JOBS_SECRETS]);
});

test("one missing secret fails and names only the missing secret", () => {
  for (const missing of REQUIRED_JOBS_SECRETS) {
    const stub = JSON.stringify(
      REQUIRED_JOBS_SECRETS.filter((name) => name !== missing).map((name) => ({ name })),
    );
    assert.throws(
      () => checkJobsSecrets(stub),
      (error) => {
        assert.match(error.message, /Missing jobs Worker secret/);
        assert.ok(error.message.includes(missing), `error must name ${missing}`);
        for (const present of REQUIRED_JOBS_SECRETS.filter((name) => name !== missing)) {
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
    () => checkJobsSecrets("[]"),
    (error) => {
      for (const name of REQUIRED_JOBS_SECRETS) {
        assert.ok(error.message.includes(name), `error must name ${name}`);
      }
      return true;
    },
  );
});

for (const stub of [
  "",
  "not json",
  '{"name":"BOT_ENDPOINT_URL"}',
  '"BOT_ENDPOINT_URL"',
  "null",
  "[{}]",
  '[{"name":""}]',
  '[{"name":null}]',
  '[{"name":42}]',
  "[null]",
  '["BOT_ENDPOINT_URL"]',
  `${allPresent} trailing`,
]) {
  test(`malformed wrangler output fails closed (${JSON.stringify(stub).slice(0, 60)})`, () => {
    assert.throws(() => checkJobsSecrets(stub), /Could not verify jobs Worker secrets/);
  });
}

test("extra fields that resemble values are ignored and never surface", () => {
  // If wrangler ever added value-bearing fields, they must not leak into
  // results, errors or CLI output. Fixture values are fake and never real.
  const stub = JSON.stringify([
    { name: "BOT_ENDPOINT_URL", value: "fixture-fake-value-aaa" },
    { name: "BOT_KEY_ID", secret: "fixture-fake-value-bbb" },
    { name: "BOT_SHARED_SECRET", extra: { nested: "fixture-fake-value-ccc" } },
  ]);
  assert.deepEqual(checkJobsSecrets(stub), [...REQUIRED_JOBS_SECRETS]);
  const names = parseSecretNames(stub);
  assert.equal(names.size, 3);
  const missing = missingRequiredSecrets(new Set(["BOT_ENDPOINT_URL"]));
  assert.deepEqual(missing, ["BOT_KEY_ID", "BOT_SHARED_SECRET"]);
  assert.throws(
    () =>
      checkJobsSecrets(
        JSON.stringify([{ name: "BOT_ENDPOINT_URL", value: "fixture-fake-value-aaa" }]),
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

const STAGING_ARGV = [
  "wrangler",
  "secret",
  "list",
  "--config",
  "wrangler.jobs.jsonc",
  "--format",
  "json",
];
const PRODUCTION_ARGV = [...STAGING_ARGV, "--env", "production"];

test("secret listing targets the staging top level by default, production only on request", () => {
  assert.deepEqual(secretListArgs(), STAGING_ARGV);
  assert.deepEqual(secretListArgs(""), STAGING_ARGV);
  assert.deepEqual(secretListArgs("production"), PRODUCTION_ARGV);
  assert.throws(() => secretListArgs("preview"), /unknown environment/);
  assert.throws(() => secretListArgs("--env=production"), /unknown environment/);
});

test("CLI env parsing accepts only the production flag", () => {
  assert.equal(parseEnv([]), "");
  assert.equal(parseEnv(["--env=production"]), "production");
  assert.throws(() => parseEnv(["--env=preview"]), /usage/);
  assert.throws(() => parseEnv(["production"]), /usage/);
  assert.throws(() => parseEnv(["--env=production", "--env=production"]), /usage/);
});

function cliWithStubbedWrangler(
  stubStdout,
  { exitCode = 0, stubStderr = "", args = [], expected = STAGING_ARGV } = {},
) {
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
const expected = ${JSON.stringify(expected)};
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
    const result = spawnSync(process.execPath, ["ci/check-jobs-secrets.mjs", ...args], {
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
  for (const name of REQUIRED_JOBS_SECRETS) {
    assert.ok(result.stdout.includes(name), `stdout must list ${name}`);
  }
  assert.equal(result.stderr, "");
});

test("CLI fails closed on a missing secret and on wrangler failure without echoing output", () => {
  const missing = cliWithStubbedWrangler(JSON.stringify([{ name: "BOT_ENDPOINT_URL" }]));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing jobs Worker secret.*BOT_KEY_ID.*BOT_SHARED_SECRET/);
  assert.ok(
    !missing.stderr.includes("BOT_ENDPOINT_URL") || missing.stderr.includes("Missing"),
    "stderr names only missing secrets",
  );
  assert.equal(missing.stdout, "");

  const failed = cliWithStubbedWrangler('{"error":"fixture denied"}', { exitCode: 1 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Could not verify jobs Worker secrets/);
  assert.ok(!failed.stderr.includes("fixture denied"), "wrangler output is never echoed");
  assert.equal(failed.stdout, "");
});

test("CLI --env=production lists the production jobs Worker with the same names-only contract", () => {
  const result = cliWithStubbedWrangler(allPresent, {
    args: ["--env=production"],
    expected: PRODUCTION_ARGV,
  });
  assert.equal(result.status, 0);
  for (const name of REQUIRED_JOBS_SECRETS) {
    assert.ok(result.stdout.includes(name), `stdout must list ${name}`);
  }
  assert.equal(result.stderr, "");

  const missing = cliWithStubbedWrangler(JSON.stringify([{ name: "BOT_ENDPOINT_URL" }]), {
    args: ["--env=production"],
    expected: PRODUCTION_ARGV,
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing jobs Worker secret.*BOT_KEY_ID.*BOT_SHARED_SECRET/);
  assert.equal(missing.stdout, "");
});

test("CLI rejects unknown flags before invoking wrangler", () => {
  // The stub can only produce exit 0 (an expected listing) or a
  // wrangler-failure exit 1; a usage error exits 2 without calling it.
  for (const args of [
    ["--env=preview"],
    ["production"],
    ["--env=production", "--env=production"],
    ["--bogus"],
  ]) {
    const result = cliWithStubbedWrangler(allPresent, { args });
    assert.equal(result.status, 2, `argv ${JSON.stringify(args)} must exit 2 (usage error)`);
    assert.match(result.stderr, /^::error::/m);
    assert.match(result.stderr, /usage: check-jobs-secrets\.mjs \[--env=production\]/);
    assert.equal(result.stdout, "");
  }
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
  for (const name of REQUIRED_JOBS_SECRETS) {
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
  assert.match(result.stderr, /Could not verify jobs Worker secrets/);
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
  assert.match(result.stderr, /Could not verify jobs Worker secrets/);
  assert.equal(result.stdout, "");
  assertNoChildCanary(result, stdoutCanary, stderrCanary);
});

test("CLI keeps child stderr out of both parent streams when a required secret is missing", () => {
  const canary = "synthetic-child-stderr-canary-missing";
  const result = cliWithStubbedWrangler(JSON.stringify([{ name: "BOT_ENDPOINT_URL" }]), {
    stubStderr: `${canary}\n`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing jobs Worker secret.*BOT_KEY_ID.*BOT_SHARED_SECRET/);
  assert.equal(result.stdout, "");
  assertNoChildCanary(result, canary);
});

test("jobs secrets preflight runs before the first Cloudflare mutation and the jobs gate and deploy", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  );
  const queues = workflow.indexOf("- name: Ensure queues exist");
  const web = workflow.indexOf("run: npx wrangler deploy --config web/wrangler.staging.jsonc");
  const secrets = workflow.indexOf("run: node ci/check-jobs-secrets.mjs");
  const gate = workflow.indexOf("- name: Re-verify exact-SHA full CI before jobs Worker deploy");
  const deploy = workflow.indexOf("run: npx wrangler deploy --config wrangler.jobs.jsonc");
  assert.ok(
    queues > 0 && web > 0 && secrets > 0 && gate > 0 && deploy > 0,
    "expected queue creation, web deploy, jobs-secrets preflight, jobs gate and jobs deploy steps in deploy.yml",
  );
  assert.ok(
    secrets < queues && secrets < web && secrets < gate && gate < deploy,
    "order must be jobs-secrets preflight, queue creation, web deploy, jobs gate, jobs deploy",
  );
});

test("web-consumer detach runs between the web deploy and the jobs gate", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  );
  const web = workflow.indexOf("run: npx wrangler deploy --config web/wrangler.staging.jsonc");
  const detach = workflow.indexOf("wrangler queues consumer remove");
  const gate = workflow.indexOf("- name: Re-verify exact-SHA full CI before jobs Worker deploy");
  assert.ok(web > 0 && detach > 0 && gate > 0, "expected web deploy, detach and jobs gate");
  assert.ok(
    web < detach && detach < gate,
    "detach must sit between the web deploy and the jobs gate",
  );
  for (const queue of ["two-sync-event", "two-internal-action"]) {
    assert.ok(workflow.includes(queue), `detach must cover ${queue}`);
  }
  assert.ok(
    workflow.includes("queues consumer list"),
    "detach must check the consumer list first so a re-run is a no-op",
  );
});
