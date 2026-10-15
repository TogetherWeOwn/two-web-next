import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  check:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";

test("the Playwright loader links the parity config before the runner guard refuses local execution", () => {
  const env = { ...process.env };
  delete env.GITHUB_ACTIONS;
  delete env.RUNNER_OS;
  // --list never starts a server or browser. The real isolation guard must
  // reject this off-runner invocation, but module linking must succeed first.
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/playwright/cli.js",
      "test",
      "--config",
      "playwright.kit-parity.config.ts",
      "--list",
    ],
    { cwd: repo, env, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /Browser smoke runs only in GitHub Actions on Linux/);
  assert.doesNotMatch(output, /ERR_IMPORT_ATTRIBUTE_MISSING/);
});

test("the isolated Kit fixture config supplies every secret required by the /up journey", () => {
  const readiness = readFileSync(new URL("../src/up-config.ts", import.meta.url), "utf8");
  const required = readiness.match(/REQUIRED_SECRETS = \[([\s\S]*?)\]/)?.[1];
  assert(required, "readiness secret inventory must exist");
  const worker = readFileSync(new URL("./kit-worker-dev.mjs", import.meta.url), "utf8");
  const vars = worker.match(/vars: \{([\s\S]*?)\n    \}/)?.[1];
  assert(vars, "fixture vars must exist");
  for (const [, name] of required.matchAll(/"([A-Z_]+)"/g)) {
    assert.match(
      vars,
      new RegExp(`${name}: \\"[^\\"]+\\"`),
      `${name} must have a synthetic fixture value`,
    );
  }
  assert.match(worker, /CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false"/);
  assert.match(worker, /CLOUDFLARE_INCLUDE_PROCESS_ENV: "false"/);
});

test("the required check runs the parity selftests in their own fail-closed step", () => {
  const step = job
    .split(/\n      - /)
    .find((entry) => entry.startsWith("name: Kit parity gate selftests\n"));
  assert(
    step,
    "check must run the parity gate selftests independently of its pinned coverage command",
  );
  assert.match(
    step,
    /^        if: \(needs\.scope\.outputs\.docs_only != 'true' && needs\.scope\.outputs\.draft != 'true'\)$/m,
  );
  assert.doesNotMatch(step, /continue-on-error:/);
  assert.equal(
    step.match(/^        run: (.+)$/m)?.[1],
    "node --test ci/kit-parity-gates.test.mjs ci/kit-parity-origin.test.mjs ci/check-kit-parity.test.mjs ci/check-kit-perf.test.mjs ci/kit-visual-accept.test.mjs ci/kit-parity-ci-wiring.test.mjs",
  );
});
