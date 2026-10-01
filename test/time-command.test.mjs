import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import TestTimingReporter from "../ci/test-timing-reporter.mjs";

function run(...args) {
  return spawnSync(process.execPath, ["ci/time-command.mjs", ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 5000,
  });
}

function records(stdout) {
  return stdout.split("\n").filter((line) => line.startsWith("TWO_TEST_TIMING "))
    .map((line) => JSON.parse(line.slice("TWO_TEST_TIMING ".length)));
}

async function cancel(script, signal = "SIGTERM") {
  const wrapper = spawn(process.execPath, ["ci/time-command.mjs", "fixture", "--", process.execPath, "-e", script], {
    env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let launcherPid;
  let sent = false;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("synthetic cancellation did not finish")), 4000);
      wrapper.stdout.on("data", (chunk) => {
        stdout += chunk;
        const ready = stdout.match(/READY (\d+)/);
        if (ready && !sent) {
          launcherPid = Number(ready[1]);
          sent = true;
          wrapper.kill(signal);
        }
      });
      wrapper.stderr.on("data", (chunk) => { stderr += chunk; });
      wrapper.on("error", reject);
      wrapper.on("close", (code, exitSignal) => {
        // Observe liveness BEFORE the test's safety cleanup can hide an orphan.
        const descendant = stdout.match(/DESCENDANT (\d+)/);
        let descendantRunning;
        if (descendant) {
          try {
            // Linux PID 1 may leave a dead, unreaped zombie visible in a container.
            descendantRunning = !/[)] [ZX] /.test(readFileSync(`/proc/${descendant[1]}/stat`, "utf8"));
          } catch (error) {
            if (error.code !== "ENOENT") { reject(error); return; }
            descendantRunning = false;
          }
        }
        resolve({ code, signal: exitSignal, stdout, stderr, descendantRunning });
      });
    });
  } finally {
    clearTimeout(timer);
    // Cleanup only this fixture's separate group, even if a regression leaves it alive.
    if (launcherPid) {
      try { process.kill(-launcherPid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
        // Also contain the old, broken wrapper, which did not create a group.
        const descendant = stdout.match(/DESCENDANT (\d+)/);
        for (const pid of [launcherPid, ...(descendant ? [Number(descendant[1])] : [])]) {
          try { process.kill(pid, "SIGKILL"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
    }
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
  }
}

it.each([0, 7])("retains the command's exit code %i and output", (code) => {
  const r = run("fixture", "--", process.execPath, "-e", `console.log('fixture output'); process.exit(${code})`);
  expect(r.status).toBe(code);
  expect(r.stdout).toContain("fixture output");
  const [timing] = records(r.stdout);
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

it.each(["SIGTERM", "SIGINT", "SIGHUP"])("does not turn %s cancellation into success when the child exits zero", async (signal) => {
  const r = await cancel(`
    process.on(${JSON.stringify(signal)}, () => process.exit(0));
    console.log('READY', process.pid);
    setInterval(() => {}, 1000);
  `, signal);
  expect(r.signal).toBe(signal);
  expect(r.code).toBeNull();
  expect(records(r.stdout)).toEqual([expect.objectContaining({ exitCode: 0, signal })]);
});

it("relays cancellation through a launcher to its descendant", async () => {
  const r = await cancel(`
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => {});
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(`
      process.on('SIGTERM', () => { console.log('DESCENDANT_CANCELLED'); process.exit(0); });
      console.log('DESCENDANT', process.pid);
      console.log('WORKER_READY');
      setInterval(() => {}, 1000);
    `)}], { stdio: ['ignore', 'pipe', 'inherit'] });
    worker.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (chunk.toString().includes('WORKER_READY')) console.log('READY', process.pid);
    });
    worker.on('exit', () => process.exit(0));
  `);
  expect(r.signal).toBe("SIGTERM");
  expect(r.stdout).toContain("DESCENDANT_CANCELLED");
  expect(records(r.stdout)).toEqual([expect.objectContaining({ exitCode: 0, signal: "SIGTERM" })]);
});

it("bounds cancellation when the launcher ignores the signal", async () => {
  const r = await cancel(`
    process.on('SIGTERM', () => {});
    console.log('READY', process.pid);
    setInterval(() => {}, 1000);
  `);
  expect(r.signal).toBe("SIGTERM");
  expect(records(r.stdout)).toEqual([expect.objectContaining({ exitCode: null, signal: "SIGTERM" })]);
});

it("cleans up a signal-ignoring descendant even when the launcher exits first", async () => {
  const r = await cancel(`
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => process.exit(0));
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(`
      process.on('SIGTERM', () => {});
      console.log('DESCENDANT', process.pid);
      setInterval(() => {}, 1000);
    `)}], { stdio: ['ignore', 'pipe', 'inherit'] });
    worker.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      console.log('READY', process.pid);
    });
  `);
  expect(r.signal).toBe("SIGTERM");
  expect(r.descendantRunning).toBe(false);
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
  expect(entries[3]).toMatchObject({ event: "test-run-end", files: 1, errorCount: 1, testRunReason: "failed", coverageReadyToTestRunEndMs: expect.any(Number) });
  expect(entries[3]).not.toHaveProperty("coverageReadyToRunEndMs");
  expect(JSON.stringify(entries)).not.toContain("sentinel-secret");
});

it("does not label a passed test-run hook as terminal coverage acceptance", () => {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "two-timing-threshold-"));
  try {
    writeFileSync(join(dir, "fixture.js"), "export function used() { return 1; }\nexport function unused() { return 2; }\n");
    writeFileSync(join(dir, "fixture.test.js"), `
      import { expect, test } from ${JSON.stringify(resolve("node_modules/vitest/dist/index.js"))};
      import { used } from './fixture.js';
      test('synthetic pass', () => expect(used()).toBe(1));
    `);
    writeFileSync(join(dir, "vitest.config.mjs"), `export default ${JSON.stringify({
      root: dir,
      test: {
        include: ["fixture.test.js"],
        reporters: ["default", resolve("ci/test-timing-reporter.mjs")],
        coverage: { provider: "v8", include: ["fixture.js"], reporter: ["text"], thresholds: { lines: 100 } },
      },
    })};`);
    const r = run("coverage", "--", process.execPath, resolve("node_modules/vitest/vitest.mjs"), "run", "--coverage", "--config", join(dir, "vitest.config.mjs"));
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Coverage for lines');
    expect(records(r.stdout).find((entry) => entry.event === "test-run-end"))
      .toMatchObject({ testRunReason: "passed", errorCount: 0, coverageReadyToTestRunEndMs: expect.any(Number) });
    expect(records(r.stdout).at(-1)).toMatchObject({ kind: "command", phase: "coverage", exitCode: 1, signal: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
