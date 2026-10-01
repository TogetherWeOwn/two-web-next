import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAuditLifecycle, stopChildProcess } from "./a11y-lifecycle.mjs";

const deferred = () => Promise.withResolvers();

// Runs in the a11y job after Chromium installation, not the browser-free check job.
for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`real Chromium ${signal} leaves the runner alive through cleanup and evidence`, { skip: process.env.A11Y_BROWSER_TESTS !== "true", timeout: 20000 }, async (t) => {
    const path = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "a11y-browser-signal-"));
    t.after(() => rm(path, { recursive: true, force: true }));
    const script = `
      import { once } from "node:events";
      import { writeFile } from "node:fs/promises";
      import { setTimeout } from "node:timers/promises";
      import { chromium } from "playwright";
      import { AUDIT_BROWSER_OPTIONS, createAuditLifecycle } from ${JSON.stringify(new URL("./a11y-lifecycle.mjs", import.meta.url).href)};
      const lifecycle = createAuditLifecycle();
      process.once(${JSON.stringify(signal)}, () => { process.exitCode = 1; void lifecycle.stop().catch(() => {}); });
      await lifecycle.acquire(() => ({}), async () => {
        // Playwright's default SIGINT handler exits after 1s; disposal must outlive it.
        await setTimeout(1200);
        await writeFile(${JSON.stringify(join(path, "disposed"))}, "fixture disposed");
      });
      await lifecycle.acquire(() => chromium.launch(AUDIT_BROWSER_OPTIONS), (browser) => browser.close());
      const cancelled = once(process, ${JSON.stringify(signal)});
      console.log("READY");
      await cancelled;
      await lifecycle.stop();
      await writeFile(${JSON.stringify(join(path, "evidence"))}, "cleanup and evidence complete");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => stopChildProcess(child));
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const exited = once(child, "exit");
    const ready = new Promise((resolve) => child.stdout.on("data", (data) => { if (data.toString().includes("READY")) resolve(); }));
    await Promise.race([ready, exited.then(() => { throw new Error(`Browser exited before readiness: ${stderr}`); })]);
    child.kill(signal);
    const [code, exitSignal] = await exited;
    assert.equal(exitSignal, null, stderr);
    assert.equal(code, 1, stderr);
    assert.equal(await readFile(join(path, "disposed"), "utf8"), "fixture disposed");
    assert.equal(await readFile(join(path, "evidence"), "utf8"), "cleanup and evidence complete");
  });
}

test("signal-exited children do not hang shutdown", { timeout: 2000 }, async () => {
  const child = spawn(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")']);
  await once(child, "exit");
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, "SIGTERM");
  await stopChildProcess(child);
});

test("shutdown terminates a running child and joins its exit", { timeout: 2000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await once(child, "spawn");
  await stopChildProcess(child);
  assert(child.exitCode !== null || child.signalCode !== null);
});

test("signal and finally callers share cleanup completion, not an early return", async () => {
  const lifecycle = createAuditLifecycle();
  const disposal = deferred();
  let calls = 0;
  await lifecycle.acquire(() => ({}), async () => { calls++; await disposal.promise; });
  const signalStop = lifecycle.stop();
  const finallyStop = lifecycle.stop();
  assert.equal(signalStop, finallyStop);
  let completed = false;
  void finallyStop.then(() => { completed = true; });
  await new Promise(setImmediate);
  assert.equal(completed, false);
  assert.equal(calls, 1);
  disposal.resolve();
  await finallyStop;
  assert.equal(completed, true);
  assert.equal(lifecycle.stop(), signalStop);
});

for (const resourceName of ["fixture", "browser", "readiness"]) {
  test(`cancellation drains and disposes an in-flight ${resourceName} before returning`, async () => {
    const lifecycle = createAuditLifecycle();
    const acquisition = deferred();
    const disposal = deferred();
    const events = [];
    const resource = lifecycle.acquire(() => acquisition.promise, async () => {
      events.push(`${resourceName} disposed`);
      await disposal.promise;
    });
    const rejected = assert.rejects(resource, /audit cancelled/);
    await new Promise(setImmediate); // The factory has started, but not resolved.
    const stopped = lifecycle.stop();
    let finished = false;
    void stopped.then(() => { finished = true; });
    assert.throws(() => lifecycle.acquire(() => { throw new Error("must not acquire"); }), /audit cancelled/);
    acquisition.resolve({});
    await rejected;
    await new Promise(setImmediate);
    assert.deepEqual(events, [`${resourceName} disposed`]);
    assert.equal(finished, false);
    disposal.resolve();
    await stopped;
    assert.equal(finished, true);
  });
}

test("cleanup attempts every owned resource even if an earlier disposal fails", async () => {
  const lifecycle = createAuditLifecycle();
  const events = [];
  for (const name of ["scratch", "fixture", "server", "browser"]) {
    await lifecycle.acquire(() => name, async () => {
      events.push(name);
      if (name === "browser") throw new Error("close failed");
    });
  }
  const stopped = lifecycle.stop();
  await assert.rejects(stopped, /close failed/);
  assert.deepEqual(events, ["browser", "server", "fixture", "scratch"]);
  assert.equal(lifecycle.stop(), stopped);
});

test("in-flight startup writes finish before removing owned scratch", async () => {
  const lifecycle = createAuditLifecycle();
  const path = await lifecycle.acquire(() => mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "a11y-cancel-test-")), (dir) => rm(dir, { recursive: true, force: true }));
  const gate = deferred();
  const operation = lifecycle.run(async () => { await gate.promise; await writeFile(join(path, "bundle"), "fixture"); });
  const rejected = assert.rejects(operation, /audit cancelled/);
  await new Promise(setImmediate);
  const stopped = lifecycle.stop();
  gate.resolve();
  await rejected;
  await stopped;
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("cancellation before the factory starts creates no resource", async () => {
  const lifecycle = createAuditLifecycle();
  let acquired = false;
  const resource = lifecycle.acquire(() => { acquired = true; });
  const rejected = assert.rejects(resource, /audit cancelled/);
  await lifecycle.stop();
  await rejected;
  assert.equal(acquired, false);
});
