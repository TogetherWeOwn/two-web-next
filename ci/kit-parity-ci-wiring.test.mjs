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

test("the Kit fixture owns the member board only on its loopback worker", () => {
  const worker = readFileSync(new URL("./kit-worker-dev.mjs", import.meta.url), "utf8");
  assert.match(worker, /KIT_PARITY_FIXTURE_MEMBER_BOARD: "true"/);
  const hooks = readFileSync(new URL("../web/src/hooks.server.ts", import.meta.url), "utf8");
  assert.match(hooks, /fixtureMemberBoard: env\.KIT_PARITY_FIXTURE_MEMBER_BOARD === "true"/);
  assert.match(hooks, /afterMemberRead:/);
  const ownership = readFileSync(new URL("../src/route-ownership.ts", import.meta.url), "utf8");
  // The override is loopback-gated in the tested core, and no deployed Kit
  // config (web/wrangler.jsonc, the preview Worker) sets the flag.
  assert.match(ownership, /fixtureManifestFor/);
  const deployed = readFileSync(new URL("../web/wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(deployed, /KIT_PARITY_FIXTURE_MEMBER_BOARD/);
  const spec = readFileSync(new URL("../e2e/kit-parity/parity.spec.ts", import.meta.url), "utf8");
  assert.match(spec, /kitFixtureOwnsMemberBoard/);
});

test("the Kit fixture owns the live event detail only on its loopback worker", () => {
  const worker = readFileSync(new URL("./kit-worker-dev.mjs", import.meta.url), "utf8");
  assert.match(worker, /KIT_PARITY_FIXTURE_EVENT_DETAIL: "true"/);
  const hooks = readFileSync(new URL("../web/src/hooks.server.ts", import.meta.url), "utf8");
  assert.match(hooks, /fixtureEventDetail: env\.KIT_PARITY_FIXTURE_EVENT_DETAIL === "true"/);
  const ownership = readFileSync(new URL("../src/route-ownership.ts", import.meta.url), "utf8");
  assert.match(ownership, /KIT_PARITY_FIXTURE_EVENT_DETAIL/);
  const deployed = readFileSync(new URL("../web/wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(deployed, /KIT_PARITY_FIXTURE_EVENT_DETAIL/);
  const spec = readFileSync(new URL("../e2e/kit-parity/parity.spec.ts", import.meta.url), "utf8");
  assert.match(spec, /kitFixtureOwnsEventDetail/);
  const helper = readFileSync(new URL("../e2e/kit-parity.ts", import.meta.url), "utf8");
  assert.match(helper, /kitFixtureOwnsEventDetail/);
});

test("Kit snapshot updates are pinned and generated Kit baselines fail the CI guard", () => {
  const config = readFileSync(new URL("../playwright.kit-parity.config.ts", import.meta.url), "utf8");
  assert.match(config, /^  updateSnapshots: "missing",$/m);
  // A missing template would send new images outside the workflow's checked directory.
  assert.ok(
    config.includes('snapshotPathTemplate: "{testDir}/../visual/__screenshots-kit__/{arg}{ext}"'),
  );
  const e2e = readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  const step = e2e
    .split(/\n      - /)
    .find((entry) => entry.startsWith("name: Uncommitted visual baselines\n"));
  assert(step, "browser-smoke must reject uncommitted visual baselines");
  assert.match(
    step,
    /git status --porcelain -- e2e\/visual\/__screenshots__ e2e\/visual\/__screenshots-kit__/,
  );
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
