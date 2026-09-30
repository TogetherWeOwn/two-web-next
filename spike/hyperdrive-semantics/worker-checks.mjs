// Finite local test runner. No Cloudflare account, token, or remote proxy.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { unstable_dev } from "wrangler";

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
const worker = await unstable_dev("spike/hyperdrive-semantics/probe-worker.ts", {
  config: "spike/hyperdrive-semantics/wrangler.probe.jsonc",
  local: true,
  ip: "127.0.0.1",
  port,
  inspectorPort: 0,
  persist: false,
  envFiles: [],
  logLevel: "error",
  experimental: { forceLocal: true, watch: false, disableExperimentalWarning: true },
});
try {
  const ready = await worker.fetch("/", { signal: AbortSignal.timeout(3000) });
  assert.equal(ready.status, 404, "Local Worker did not answer the DB-free readiness check");
  const response = await worker.fetch("/spike-run", {
    method: "POST", signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  assert.equal(response.status, 200, "Worker control probe failed");
  assert.equal(result.path, "local-worker-direct-agent-testdb");
  assert.equal(result.ok, true);
  assert.equal(result.passed, 3);
  assert.equal(result.total, 3);
} finally {
  await worker.stop();
}
