import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import TestTimingReporter from "../ci/test-timing-reporter.mjs";

function run(...args) {
  return spawnSync(process.execPath, ["ci/time-command.mjs", ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 5000,
  });
}

it.each([0, 7])("retains the command's exit code %i and output", (code) => {
  const r = run("fixture", "--", process.execPath, "-e", `console.log('fixture output'); process.exit(${code})`);
  expect(r.status).toBe(code);
  expect(r.stdout).toContain("fixture output");
  const line = r.stdout.split("\n").find((line) => line.startsWith("TWO_TEST_TIMING "));
  const timing = JSON.parse(line.slice("TWO_TEST_TIMING ".length));
  expect(timing).toEqual({ kind: "command", phase: "fixture", elapsedMs: expect.any(Number), exitCode: code, signal: null });
  expect(timing.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(r.stdout).not.toContain("console.log(");
});

it("fails invalid invocation and spawn failures instead of hiding a red command", () => {
  expect(run("fixture", "no-separator", "missing-command").status).toBe(2);
  expect(run("fixture", "--", "two-nonexistent-diagnostic-command").status).toBe(1);
});

it("preserves a signal exit", () => {
  const r = run("fixture", "--", process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')");
  expect(r.signal).toBe("SIGTERM");
});

it("reports public module diagnostics without serializing errors or coverage payloads", () => {
  const reporter = new TestTimingReporter();
  const entries = [];
  reporter.emit = (event, fields) => entries.push({ event, ...fields });
  reporter.onTestRunStart([{}]);
  reporter.onTestModuleEnd({ relativeModuleId: "test/synthetic.test.ts", state: () => "failed",
    diagnostic: () => ({ collectDuration: 10, duration: 20, prepareDuration: 3, environmentSetupDuration: 2, setupDuration: 1, error: "sentinel-secret" }),
  });
  reporter.onCoverage({ secret: "sentinel-secret" });
  reporter.onTestRunEnd([{}], [new Error("sentinel-secret")], "failed");
  expect(entries[1]).toEqual({ event: "module-end", file: "test/synthetic.test.ts", state: "failed", collectMs: 10, testsAndHooksMs: 20, prepareMs: 3, environmentSetupMs: 2, setupMs: 1 });
  expect(entries[3]).toMatchObject({ event: "run-end", files: 1, errorCount: 1, reason: "failed", coverageReadyToRunEndMs: expect.any(Number) });
  expect(JSON.stringify(entries)).not.toContain("sentinel-secret");
});
