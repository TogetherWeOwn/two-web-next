import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkExecuted } from "./a11y-require-executed.mjs";

const SUITE = "native admin event text limits";
const MIN = 48;
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = workflow.split("\n  a11y:\n")[1]?.split(/\n  [\w-]+:\n/)[0] ?? "";
const step = job.match(
  /      - name: Admin event native Unicode regressions[^\n]*(\n[\s\S]*?)(?=\n      - |\n?$)/,
)?.[1];

const report = (statuses) => ({
  testResults: [
    {
      assertionResults: [
        { ancestorTitles: ["admin event code-point contract"], status: "passed" },
        ...statuses.map((status) => ({ ancestorTitles: [SUITE], status })),
      ],
    },
  ],
});

test("the a11y job runs the native admin browser suite with the opt-in and the executed-count verifier", () => {
  assert(step, "a11y job must keep the native admin Unicode step");
  // Dropping the enabling env turns the whole matrix into a silent skip.
  assert.match(step, /\n        env:\n          ADMIN_EVENT_BROWSER_TESTS: "true"\n/);
  assert.match(
    step,
    /\n          npx vitest run test\/admin-event-native-unicode\.test\.ts --reporter=default --reporter=json --outputFile\.json=artifacts\/a11y\/admin-native-unicode\.json\n/,
  );
  assert.match(
    step,
    /\n          node ci\/a11y-require-executed\.mjs artifacts\/a11y\/admin-native-unicode\.json "native admin event text limits" 48\n?$/,
  );
  // No bypass: the step is unconditional inside a job that already runs on app/db/full.
  assert.doesNotMatch(step, /continue-on-error:|\n        if:/);
  assert.doesNotMatch(step, /ADMIN_EVENT_BROWSER_TESTS: "(?!true")/);
  // Chromium is installed before the suite runs, through the existing cache.
  assert(
    job.indexOf("npx playwright install --with-deps chromium") <
      job.indexOf("Admin event native Unicode regressions"),
  );
  assert.match(
    job,
    /key: playwright-chromium-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/,
  );
});

test("the a11y job runs for every input of the native admin suite and for main", () => {
  assert.match(
    workflow,
    /\n    if: needs\.scope\.outputs\.draft != 'true' && \(needs\.scope\.outputs\.full == 'true' \|\| needs\.scope\.outputs\.app == 'true' \|\| needs\.scope\.outputs\.db == 'true'\)\n    # Overflow switch/,
  );
  // Non-PR events (main pushes, nightly, dispatch) hardcode app and full.
  assert.match(
    workflow,
    /echo "app=true"\n\s+echo "worker=true"\n\s+echo "db=true"\n\s+echo "full=true"/,
  );
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "native-scope-"));
  for (const path of [
    "test/admin-event-native-unicode.test.ts",
    "assets/islands/admin-event-text-limits.js",
    "public/islands/admin-event-editor.js",
    "src/admin/pages.tsx",
    "src/admin/validation.ts",
  ]) {
    const list = join(dir, "files.tsv");
    writeFileSync(list, `${path}\t\n`);
    const result = spawnSync("bash", ["ci/change-scope.sh", list, "1"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^app=true$/m, path);
  }
});

test("the suite keeps intercepted fixtures with no real network or database", async () => {
  const suite = await readFile(
    new URL("../test/admin-event-native-unicode.test.ts", import.meta.url),
    "utf8",
  );
  assert.match(suite, /process\.env\.ADMIN_EVENT_BROWSER_TESTS !== "true"/);
  assert.match(suite, /page\.route\("\*\*\/\*"/);
  assert.match(suite, /route\.fulfill\(\{ status: 404, body: "" \}\)/);
  assert.doesNotMatch(suite, /route\.(continue|fallback)\(|postgres|DATABASE_URL/);
});

test("the verifier accepts a fully executed suite and names the count", () => {
  const line = checkExecuted(report(Array(MIN).fill("passed")), SUITE, MIN);
  assert.match(line, /48 cases executed and passed, 0 skipped/);
});

test("the verifier rejects skipped, failed, missing or no cases", () => {
  assert.throws(() => checkExecuted(report(Array(MIN).fill("skipped")), SUITE, MIN), /48 of 48/);
  assert.throws(
    () => checkExecuted(report([...Array(MIN - 1).fill("passed"), "failed"]), SUITE, MIN),
    /1 of 48/,
  );
  assert.throws(
    () => checkExecuted(report(Array(MIN - 1).fill("passed")), SUITE, MIN),
    /expected at least 48/,
  );
  assert.throws(() => checkExecuted({ testResults: [] }, SUITE, MIN), /expected at least 48/);
  assert.throws(
    () => checkExecuted(report(Array(MIN).fill("passed")), SUITE, 0),
    /positive integer/,
  );
});
