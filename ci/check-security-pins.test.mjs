// Offline pins for the security-pins gate: stub-runner dynamics, CLI JSON
// shapes and exit codes. No vitest, network or database: every case runs with
// node --test on a bare checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as pins from "./check-security-pins.mjs";
import { checkInlineAllowlist, runDynamic } from "./check-security-pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "ci/check-security-pins.mjs");

function passingReport() {
  const assertion = (describe) => ({
    ancestorTitles: [describe],
    title: "pins its contract",
    status: "passed",
  });
  return {
    success: true,
    numFailedTestSuites: 0,
    testResults: [
      {
        status: "passed",
        assertionResults: [
          assertion("host-admission forwarding contract"),
          assertion("inline-style route sweep"),
          assertion("leaf-bundle hash lifecycle"),
        ],
      },
    ],
  };
}

function dynamicResult(processResult = {}, report = passingReport()) {
  return runDynamic(["test/example.test.ts"], (_command, args) => {
    const path = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
    writeFileSync(path, JSON.stringify(report));
    return { status: 0, signal: null, ...processResult };
  });
}

test("a clean process and report pass with the process status in JSON", () => {
  const result = dynamicResult();
  assert.equal(result.ok, true);
  assert.equal(result.exitStatus, 0);
  assert.deepEqual(
    result.checks.map((c) => c.id),
    ["host-forward-matrix", "style-route-sweep", "leaf-hash-lifecycle"],
  );
});

for (const [label, processResult, report] of [
  ["non-zero exit", { status: 1 }, passingReport()],
  ["terminated process", { status: null, signal: "SIGTERM" }, passingReport()],
  [
    "spawn failure",
    { error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }) },
    passingReport(),
  ],
  ["report-level failure", {}, { ...passingReport(), success: false }],
  ["failed suite count", {}, { ...passingReport(), numFailedTestSuites: 1 }],
]) {
  test(`passing assertions do not mask ${label}`, () => {
    const result = dynamicResult(processResult, report);
    assert.equal(result.ok, false);
    assert.equal(result.code, "suite_run_failed");
    assert.equal(result.retryable, false);
    assert.match(result.next_action, /vitest/);
  });
}

test("a missing report fails with suite_report_missing", () => {
  const result = runDynamic(["test/example.test.ts"], () => ({
    status: 1,
    signal: null,
    error: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "suite_report_missing");
  assert.equal(result.retryable, false);
});

test("an unreadable report fails with suite_report_invalid", () => {
  const result = runDynamic(["test/example.test.ts"], (_command, args) => {
    const path = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
    writeFileSync(path, "not json");
    return { status: 0, signal: null };
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "suite_report_invalid");
});

test("a failing assertion fails with suite_contract_failed", () => {
  const report = passingReport();
  report.testResults[0].assertionResults[1].status = "failed";
  const result = dynamicResult({}, report);
  assert.equal(result.ok, false);
  assert.equal(result.code, "suite_contract_failed");
  assert.equal(result.checks.find((c) => c.id === "style-route-sweep").status, "fail");
});

test("a renamed describe fails closed as unmapped, never silently green", () => {
  const report = passingReport();
  report.testResults[0].assertionResults[0].ancestorTitles = ["renamed contract"];
  const result = dynamicResult({}, report);
  assert.equal(result.ok, false);
  assert.equal(result.code, "suite_contract_failed");
  assert.equal(result.unmapped.length, 1);
  assert.equal(result.checks.find((c) => c.id === "host-forward-matrix").status, "vacuous");
});

test("an allowlist widening fails the static pin", () => {
  const widened = `const INLINE_CRITICAL_CSS_PATHS = new Set([\n  "/",\n  "/join",\n]);`;
  const result = checkInlineAllowlist(widened);
  assert.equal(result.status, "fail");
  assert.match(result.detail, /\/join/);
});

test("a spread-widened allowlist fails closed, not silently exact", () => {
  const widened = `const INLINE_CRITICAL_CSS_PATHS = new Set([\n  "/",\n  "/about",\n  "/faq",\n  "/rules",\n  "/privacy",\n  ...EXTRA_INLINE_PATHS,\n]);`;
  const result = checkInlineAllowlist(widened);
  assert.equal(result.status, "fail");
  assert.match(result.detail, /does not parse/);
});

test("a commented-out path does not satisfy the allowlist", () => {
  const narrowed = `const INLINE_CRITICAL_CSS_PATHS = new Set([\n  "/",\n  "/about",\n  "/faq",\n  "/rules",\n  // "/privacy",\n]);`;
  const result = checkInlineAllowlist(narrowed);
  assert.equal(result.status, "fail");
});

test("a post-definition .add widening fails closed, not silently exact", () => {
  const widened = `const INLINE_CRITICAL_CSS_PATHS = new Set([\n  "/",\n  "/about",\n  "/faq",\n  "/rules",\n  "/privacy",\n]);\n(INLINE_CRITICAL_CSS_PATHS as unknown as Set<string>).add("/profile");`;
  const result = checkInlineAllowlist(widened);
  assert.equal(result.status, "fail");
});

function runGate(args) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    return { exit: 0, stdout };
  } catch (err) {
    return { exit: err.status ?? 1, stdout: String(err.stdout ?? "") };
  }
}

test("CLI --static-only prints one pure-JSON summary with version 1", () => {
  const { exit, stdout } = runGate(["--static-only"]);
  assert.equal(exit, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.check, "security-pins");
  assert.equal(report.version, 1);
  assert.equal(report.ok, true);
  assert.equal(report.static.checks.length, 5);
});

test("static pins verify both generated bundles fail-closed", () => {
  const { exit, stdout } = runGate(["--static-only"]);
  assert.equal(exit, 0);
  const report = JSON.parse(stdout);
  const byId = new Map(report.static.checks.map((check) => [check.id, check.status]));
  // One lifecycle pin per bundle: the full leaf bundle (shared sources plus
  // the leaf-only seam) and the homepage bundle (shared sources only).
  assert.equal(byId.get("leaf-lifecycle-static"), "pass");
  assert.equal(byId.get("home-lifecycle-static"), "pass");
});

test("the homepage lifecycle checker passes on real files and fails on drift", () => {
  assert.equal(
    typeof pins.checkHomeLifecycleStatic,
    "function",
    "checkHomeLifecycleStatic must be exported",
  );
  assert.equal(pins.checkHomeLifecycleStatic().status, "pass");
  const homeModule = join(ROOT, "src/home-critical-css.ts");
  assert.ok(existsSync(homeModule), "src/home-critical-css.ts must exist");
  const moduleSource = readFileSync(homeModule, "utf8");
  assert.equal(pins.checkHomeLifecycleStatic(["drifted source"], moduleSource).status, "fail");
  assert.equal(
    pins.checkHomeLifecycleStatic(["x"], "// GENERATED from other.css\nrest").status,
    "fail",
  );
});

test("CLI usage errors are JSON with a fixed code and next_action", () => {
  const { exit, stdout } = runGate(["--bogus"]);
  assert.equal(exit, 2);
  assert.deepEqual(JSON.parse(stdout), {
    check: "security-pins",
    version: 1,
    ok: false,
    error_code: "invalid_arguments",
    retryable: false,
    next_action:
      "Run node ci/check-security-pins.mjs with no flags (full gate), --static-only (no suites), or --selftest.",
  });
});
