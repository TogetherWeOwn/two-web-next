// Finite local test runner. No Cloudflare account, token, or remote proxy.
//
// Startup (unstable_dev -> workerd readiness) is bounded by runWithWorker's
// wall-clock budget: a never-ready startup exits 2 without reaching the
// readiness/cleanup block. The shell wrapper owns this process's group and
// TERM/KILLs it on expiry, so a hung startup cannot be orphaned: a
// Promise.race alone would leave the dev process running.
// Check failures exit 1 after worker.stop(); success exits 0.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { unstable_dev } from "wrangler";
import {
  CHECK_FAILURE_EXIT,
  runWithWorker,
  STARTUP_FAILURE_EXIT,
  STARTUP_TIMEOUT_MS,
} from "./runner.ts";

const STARTUP_TIMEOUT_S = Math.ceil(STARTUP_TIMEOUT_MS / 1000);
// Keep the full one-shot run inside the shell wrapper's process-group budget.
const SHELL_TIMEOUT_S = 600;

// unstable_dev's fetch helper cannot address port 0; allocate a concrete port.
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
// Local driver defaults must not inherit alternate credentials or connection options.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PG")) delete process.env[key];
}
process.env.WRANGLER_SEND_METRICS = "false";
const result = await runWithWorker({
  timeoutMs: STARTUP_TIMEOUT_MS,
  startWorker: () => unstable_dev("spike/hyperdrive-semantics/probe-worker.ts", {
    config: "spike/hyperdrive-semantics/wrangler.probe.jsonc",
    local: true,
    ip: "127.0.0.1",
    port,
    inspectorPort: 0,
    persist: false,
    envFiles: [],
    logLevel: "error",
    experimental: { forceLocal: true, watch: false, disableExperimentalWarning: true },
  }),
  runChecks: async (worker) => {
    // workerd cold boot can exceed a single short timeout; retry readiness.
    let ready;
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        ready = await worker.fetch("/", { signal: AbortSignal.timeout(5000) });
        break;
      } catch (err) {
        if (attempt === 12) throw err;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    assert.equal(ready.status, 404, "Local Worker did not answer the DB-free readiness check");
    const response = await worker.fetch("/spike-run", {
      method: "POST", signal: AbortSignal.timeout(30000),
    });
    const checkResult = await response.json();
    console.log(JSON.stringify(checkResult, null, 2));
    assert.equal(response.status, 200, "Worker control probe failed");
    assert.equal(checkResult.path, "local-worker-direct-agent-testdb");
    assert.equal(checkResult.ok, true);
    assert.equal(checkResult.passed, 3);
    assert.equal(checkResult.total, 3);
  },
});
if (result.exitCode !== 0) {
  const tag = result.exitCode === STARTUP_FAILURE_EXIT
    ? `startup did not become ready within ${STARTUP_TIMEOUT_S}s (shell budget ${SHELL_TIMEOUT_S}s)`
    : "checks failed";
  console.error(`worker-checks: ${tag}; teardown attempted`);
  if (result.error instanceof Error) console.error(`worker-checks: ${result.error.message}`);
  process.exit(result.exitCode === STARTUP_FAILURE_EXIT ? STARTUP_FAILURE_EXIT : CHECK_FAILURE_EXIT);
}
