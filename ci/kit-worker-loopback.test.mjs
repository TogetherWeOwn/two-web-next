import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as launcher from "./kit-worker-loopback.mjs";

const loopback = "127.0.0.1";
const wrangler = fileURLToPath(new URL("../web/node_modules/.bin/wrangler", import.meta.url));
function failStartup(message) {
  return spawn(process.execPath, [
    "-e",
    "console.error(process.argv[1]); process.exitCode = 1",
    message,
  ]);
}

test("pinned Wrangler recovers from an occupied loopback port", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "kit-worker-loopback-test-"));
  const workers = [];
  let foreignRequests = 0;
  const occupied = createServer((_request, response) => {
    foreignRequests += 1;
    response.end("foreign server");
  }).listen(0, loopback);
  try {
    await once(occupied, "listening");
    const config = join(scratch, "wrangler.json");
    await writeFile(
      join(scratch, "worker.mjs"),
      `let requests = 0;
export default { fetch: (_, env) => new Response(env.APP_URL, {
  headers: { "x-fixture-requests": String(++requests) },
}) };
`,
    );
    const { port } = occupied.address();
    let selected = 0;
    const selectPort = () => (selected++ === 0 ? port : launcher.unusedPort());
    const worker = await launcher.startLoopbackWorker(
      "collision-proof",
      async (port, origin) => {
        if (workers.length > 0) assert.equal(workers[0].stopped, true);
        await writeFile(
          config,
          JSON.stringify({
            name: "two-web-bind-collision-proof",
            main: "worker.mjs",
            compatibility_date: "2026-09-29",
            vars: { APP_URL: origin },
            dev: { ip: loopback, port, inspector_port: 0 },
          }),
        );
        return spawn(wrangler, ["dev", "--config", config, "--local", "--log-level", "error"], {
          cwd: scratch,
          env: {
            ...process.env,
            WRANGLER_SEND_METRICS: "false",
            CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
            CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
            WRANGLER_LOG_PATH: join(scratch, "wrangler.log"),
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
      },
      workers,
      { selectPort },
    );
    await assert.rejects(launcher.waitForBind(worker, 0), /Timed out waiting for Wrangler to bind/);
    await assert.rejects(launcher.waitForHttpReady(worker, 0), /Timed out waiting for/);
    assert.equal(await worker.readiness, null);
    assert.equal(foreignRequests, 0);
    assert.equal(workers.length, 2);
    assert.equal(workers[0].child.exitCode, 1);
    assert.notEqual(worker.origin, `http://${loopback}:${port}`);
    const response = await fetch(`${worker.origin}/favicon.ico`);
    assert.ok(Number(response.headers.get("x-fixture-requests")) >= 2);
    assert.equal(await response.text(), worker.origin);
  } finally {
    for (const worker of workers.filter(({ stopped }) => !stopped)) worker.child.kill("SIGTERM");
    await Promise.all(workers.map(({ closed }) => closed));
    await new Promise((resolve) => occupied.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
  assert.ok(workers.every(({ stopped }) => stopped));
});

test("startup reports the final bind collision and never retries other errors", async () => {
  const port = 32123;
  const options = { selectPort: () => port };
  const collision = `Address already in use (${loopback}:${port}). Please check that you are not already running a server on this address or specify a different port with --port.`;
  for (const [message, attempts] of [
    [collision, 3],
    ["Synthetic startup failure", 1],
  ]) {
    const workers = [];
    await assert.rejects(
      launcher.startLoopbackWorker("synthetic", () => failStartup(message), workers, options),
      (error) =>
        error.message.startsWith("Wrangler dev exited before ready (exit 1)") &&
        error.message.includes(message),
    );
    assert.equal(workers.length, attempts);
    assert.ok(workers.every(({ stopped }) => stopped));
  }
});
