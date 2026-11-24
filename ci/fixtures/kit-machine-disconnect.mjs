import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { builtinModules } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { mcpListEventsArgs, mcpToolCall } from "../../test/helpers/machine-requests.ts";

const probePath = "/__fixture/mcp-disconnect";

async function observe(origin, event, signal) {
  let events;
  do {
    signal.throwIfAborted();
    const response = await fetch(new URL(probePath, origin), { redirect: "error", signal });
    assert.equal(response.status, 200, "disconnect observation endpoint");
    events = await response.json();
    if (events.includes(event)) return events;
    // The observer can run before the other request's callback is scheduled.
    await delay(25);
  } while (!signal.aborted);
  assert.fail(`Timed out waiting for ${event}. Worker observed ${JSON.stringify(events)}`);
}

async function checkDisconnect(origin) {
  const body = JSON.stringify(mcpToolCall("list_events", mcpListEventsArgs, 93));
  const client = request(new URL("/mcp", origin), {
    method: "POST",
    agent: false,
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  // Retain request errors through teardown, including if the header wait fails.
  let clientError;
  client.on("error", (error) => {
    clientError = error;
  });
  try {
    const start = AbortSignal.timeout(5_000);
    const headers = once(client, "response", { signal: start });
    client.end(body);
    const [response] = await headers;
    let responseError;
    response.on("error", (error) => {
      responseError = error;
    });
    response.resume();
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /^text\/event-stream(?:;|$)/);
    assert.deepEqual(await observe(origin, "read-held", start), ["read-held"]);
    assert.ifError(clientError);
    assert.ifError(responseError);
    const { socket } = client;
    assert.ok(socket && !socket.destroyed && !response.complete, "MCP HTTP exchange is open");

    // Reset the dedicated TCP connection. A FIN can leave the peer's write
    // side open; cancelling a Web Streams reader would stay inside the Worker.
    const closed = once(socket, "close", { signal: AbortSignal.timeout(2_000) });
    socket.resetAndDestroy();
    await closed;
    assert.equal(response.complete, false, "client closed before SSE completed");
    assert.deepEqual(await observe(origin, "waitUntil-cleanup", AbortSignal.timeout(5_000)), [
      "read-held",
      "incoming-abort",
      "read-settled:abort",
      "waitUntil-cleanup",
    ]);
  } finally {
    client.destroy();
  }
}

export async function verifyKitMachineDisconnect(worker, scratch) {
  const fixture = fileURLToPath(new URL("./kit-machine-parity.mjs", import.meta.url));
  const bundle = await build({
    stdin: {
      contents: `import inner from ${JSON.stringify(worker)};
import { machineDisconnectWorker } from ${JSON.stringify(fixture)};
export default machineDisconnectWorker(inner, ${JSON.stringify(probePath)});`,
      resolveDir: scratch,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: [...builtinModules, "node:*", "cloudflare:*"],
  });
  const host = "127.0.0.1";
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      host,
      port: 0,
      modules: true,
      modulesRoot: scratch,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-09-29",
      // ADR 0002 §7. This fixture predates the 2026-11-17 default.
      compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
      // Wrangler's dev proxy can keep its upstream request open after the
      // downstream socket closes. Connect straight to workerd instead.
      unsafeDirectSockets: [{ host, port: 0 }],
      outboundService() {
        throw new Error("MCP disconnect fixture has no outbound services");
      },
    }),
  );
  try {
    const origin = await runtime.unsafeGetDirectURL();
    assert.equal(origin.hostname, host, "direct Worker listener must stay on loopback");
    await checkDisconnect(origin);
  } finally {
    await runtime.dispose();
  }
  console.log(
    "PASS installed Kit MCP TCP reset propagated to request.signal and waitUntil cleanup",
  );
}
