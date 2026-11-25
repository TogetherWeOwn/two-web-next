import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startLoopbackWorker } from "./kit-worker-loopback.mjs";

const loopback = "127.0.0.1";
const wrangler = fileURLToPath(new URL("../web/node_modules/.bin/wrangler", import.meta.url));
function failStartup(message) {
  return spawn(
    process.execPath,
    ["-e", "console.error(process.argv[1]); process.exitCode = 1", message],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
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
    const main = join(scratch, "worker.mjs");
    const config = join(scratch, "wrangler.json");
    await writeFile(main, "export default { fetch: (_, env) => new Response(env.APP_URL) };\n");
    const { port } = occupied.address();
    let selected = 0;
    const selectPort = async () => {
      if (selected++ === 0) return port;
      const candidate = createServer().listen(0, loopback);
      await once(candidate, "listening");
      const { port: newPort } = candidate.address();
      await new Promise((resolve) => candidate.close(resolve));
      return newPort;
    };
    const worker = await startLoopbackWorker(
      "collision-proof",
      async (port, origin) => {
        if (workers.length > 0) assert.equal(workers[0].stopped, true);
        await writeFile(
          config,
          JSON.stringify({
            name: "two-web-bind-collision-proof",
            main,
            compatibility_date: "2026-09-29",
            vars: { APP_URL: origin },
          }),
        );
        return spawn(
          wrangler,
          [
            "dev",
            "--config",
            config,
            "--local",
            "--ip",
            loopback,
            "--port",
            String(port),
            "--inspector-port",
            "0",
            "--persist-to",
            join(scratch, "state"),
            "--log-level",
            "error",
          ],
          {
            cwd: scratch,
            env: {
              ...process.env,
              WRANGLER_SEND_METRICS: "false",
              CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
              CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
              WRANGLER_LOG_PATH: join(scratch, "wrangler.log"),
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
      },
      workers,
      { selectPort },
    );
    assert.equal(workers.length, 2);
    assert.equal(workers[0].child.exitCode, 1);
    assert.notEqual(worker.origin, `http://${loopback}:${port}`);
    const response = await fetch(`${worker.origin}/favicon.ico`);
    assert.equal(await response.text(), worker.origin);
    assert.equal(foreignRequests, 0);
  } finally {
    // The real Wrangler wrapper forwards SIGTERM to its local child.
    for (const worker of workers) {
      if (!worker.stopped) worker.child.kill("SIGTERM");
    }
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
  const collisions = [];
  const failures = [];
  await assert.rejects(
    startLoopbackWorker("synthetic", () => failStartup(collision), collisions, options),
    /Wrangler dev exited before ready \(exit 1\)[\s\S]*Address already in use/,
  );
  assert.equal(collisions.length, 3);
  await assert.rejects(
    startLoopbackWorker(
      "synthetic",
      () => failStartup("Synthetic startup failure"),
      failures,
      options,
    ),
    /Wrangler dev exited before ready \(exit 1\)[\s\S]*Synthetic startup failure/,
  );
  assert.equal(failures.length, 1);
  assert.ok([...collisions, ...failures].every(({ stopped }) => stopped));
});
