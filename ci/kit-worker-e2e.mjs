#!/usr/bin/env node
// Exercise the adapter-generated Kit Worker on loopback with the disposable CI
// database. This must never inherit the preview config's Hyperdrive binding.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(repo, "web");
const worker = join(web, ".svelte-kit/cloudflare/_worker.js");
const assets = join(web, ".svelte-kit/cloudflare");
const databaseUrl = process.env.KIT_WORKER_TEST_DATABASE_URL;

function requireDisposableDatabase(value) {
  if (!value)
    throw new Error("KIT_WORKER_TEST_DATABASE_URL must point to a disposable local Postgres");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("KIT_WORKER_TEST_DATABASE_URL must be a valid Postgres URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Kit Worker fixture accepts only a Postgres URL");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("Kit Worker fixture accepts only loopback Postgres hosts");
  }
}

function listen(child, origin, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolveReady, reject) => {
    const attempt = async () => {
      if (child.exitCode !== null) {
        reject(new Error(`Wrangler dev exited before ready (exit ${child.exitCode})`));
        return;
      }
      try {
        const response = await fetch(`${origin}/favicon.ico`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          resolveReady();
          return;
        }
      } catch {
        // Wrangler has not bound its local listener yet.
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("Timed out waiting for the generated Kit Worker"));
        return;
      }
      setTimeout(attempt, 250);
    };
    void attempt();
  });
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

requireDisposableDatabase(databaseUrl);
const port = await unusedPort();
const origin = `http://127.0.0.1:${port}`;
const scratch = await mkdtemp(
  join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-worker-e2e-"),
);
const config = join(scratch, "wrangler.jsonc");
const configBody = {
  name: "two-web-kit-worker-ci-fixture",
  main: worker,
  compatibility_date: "2026-09-29",
  compatibility_flags: ["nodejs_compat"],
  assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
  vars: {
    APP_URL: origin,
    DATABASE_URL: databaseUrl,
    FEATURED_IMAGE_HOSTS: "",
    DISCORD_CLIENT_ID: "ci-fixture-client",
    DISCORD_CLIENT_SECRET: "ci-fixture-secret",
    DISCORD_BOT_TOKEN: "ci-fixture-token",
    DISCORD_GUILD_ID: "ci-fixture-guild",
    DISCORD_MODERATOR_ROLE_IDS: "",
    DISCORD_INVITE_URL: "https://example.invalid/invite",
    AGENT_EVENTS_ENABLED: "false",
  },
};
await writeFile(config, JSON.stringify(configBody));
const wrangler = join(web, "node_modules/.bin/wrangler");
const child = spawn(
  wrangler,
  [
    "dev",
    "--config",
    config,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    "0",
    "--log-level",
    "error",
  ],
  {
    cwd: repo,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    },
    stdio: ["ignore", "ignore", "ignore"],
  },
);
try {
  await listen(child, origin);

  const archive = await fetch(`${origin}/events/past`);
  const archiveHtml = await archive.text();
  assert.equal(archive.status, 200, "generated Worker serves the archive route");
  assert.match(archive.headers.get("content-type") ?? "", /text\/html/);
  assert.match(
    archiveHtml,
    /data-testid="past-events"/,
    "archive page is rendered by the generated Kit Worker",
  );
  assert.match(
    archiveHtml,
    /data-testid="past-events-empty"/,
    "archive load reads the empty disposable event database",
  );
  console.log("PASS generated Worker archive request");

  const api = await fetch(`${origin}/api/agent-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(api.status, 404, "disabled fixture ingress fails closed at the Hono API route");
  assert.equal((await api.json()).reason, "ingress_disabled");
  console.log("PASS generated Worker Hono API dispatch");

  const asset = await fetch(`${origin}/favicon.ico`);
  assert.equal(asset.status, 200, "public assets are served through the generated Worker");
  assert.match(
    asset.headers.get("content-type") ?? "",
    /image\/x-icon|image\/vnd\.microsoft\.icon/,
  );
  assert.ok((await asset.arrayBuffer()).byteLength > 0, "favicon response has a body");
  console.log("PASS generated Worker public asset response");
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveExit) => setTimeout(resolveExit, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(scratch, { recursive: true, force: true });
}
