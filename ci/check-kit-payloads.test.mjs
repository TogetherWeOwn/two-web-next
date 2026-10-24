import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditCoverage, listKitServerFiles, runDynamic } from "./check-kit-payloads.mjs";

const truth = JSON.parse(
  readFileSync(new URL("./kit-public-payloads.json", import.meta.url), "utf8"),
);

function passingReport() {
  return {
    success: true,
    numFailedTestSuites: 0,
    testResults: [
      {
        status: "passed",
        assertionResults: truth.checks.map((check) => ({
          ancestorTitles: [check.tests[0]],
          title: check.route?.startsWith("GET /hotzones/")
            ? `${check.route.split("/").at(-1)} serves the aggregate`
            : `${check.route ?? check.id} serves its payload`,
          status: "passed",
        })),
      },
    ],
  };
}

function dynamicResult(processResult = {}, report = passingReport()) {
  return runDynamic(truth, (_command, args) => {
    const path = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
    writeFileSync(path, JSON.stringify(report));
    return { status: 0, signal: null, ...processResult };
  });
}

test("a clean process and report pass with the process status in JSON", () => {
  const result = dynamicResult();
  assert.equal(result.ok, true);
  assert.equal(result.exitStatus, 0);
});

for (const [label, processResult, report] of [
  ["non-zero teardown exit", { status: 1 }, passingReport()],
  ["terminated process", { status: null, signal: "SIGTERM" }, passingReport()],
  [
    "spawn failure",
    { error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }) },
    passingReport(),
  ],
  ["report-level failure", {}, { ...passingReport(), success: false }],
  ["failed suite count", {}, { ...passingReport(), numFailedTestSuites: 1 }],
  [
    "failed suite hook",
    {},
    {
      ...passingReport(),
      testResults: passingReport().testResults.map((r) => ({ ...r, status: "failed" })),
    },
  ],
]) {
  test(`passing assertions do not mask ${label}`, () => {
    const result = dynamicResult(processResult, report);
    assert.equal(result.passed, truth.checks.length);
    assert.equal(result.ok, false);
    assert.equal(result.code, "suite_run_failed");
    assert.equal(result.retryable, false);
    assert.match(result.next_action, /Vitest/);
  });
}

test("a missing report preserves the process failure and remediation", () => {
  const result = runDynamic(truth, () => ({
    status: null,
    signal: null,
    error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.exitStatus, null);
  assert.equal(result.spawnError, "ENOENT");
  assert.equal(result.code, "suite_report_missing");
  assert.match(result.next_action, /Vitest/);
});

for (const name of [
  "+page.server.ts",
  "+layout.server.ts",
  "+server.ts",
  "+page.server.js",
  "+layout.server.js",
  "+server.js",
  "+page.server.mjs",
  "+future.server.jsx",
]) {
  test(`enumeration fails closed on unclassified ${name}`, () => {
    const dir = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-payload-enumeration-"),
    );
    try {
      writeFileSync(join(dir, name), "export const load = () => ({ member: 'fixture' });\n");
      writeFileSync(join(dir, "+page.svelte"), "<p>Not a server binding</p>\n");
      const files = listKitServerFiles(dir);
      assert.equal(files.length, 1);
      assert.ok(files[0].endsWith(`/${name}`));
      assert.deepEqual(auditCoverage(files, {}).unlisted, files);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the root aggregate and blocking CI invoke the contract and selftests", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const command of ["npm run check:kit-payloads:selftest", "npm run check:kit-payloads"]) {
    assert.ok(pkg.scripts.check.split(" && ").includes(command), `root check omits ${command}`);
  }
  assert.ok(
    pkg.scripts["check:kit-payloads:selftest"].includes(
      "node --test ci/check-kit-payloads.test.mjs",
    ),
  );
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const checkJob = workflow.slice(
    workflow.indexOf("\n  check:"),
    workflow.indexOf("\n  node22-compat:"),
  );
  assert.match(
    checkJob,
    /run: npm run check:kit-payloads:selftest && node ci\/check-kit-payloads\.mjs --static-only/,
  );
  assert.match(checkJob, /run: npm run check:kit-payloads\s*\n/);
});
