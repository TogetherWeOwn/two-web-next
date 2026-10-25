#!/usr/bin/env node
// Exercise the adapter-generated Kit Worker on loopback with the disposable CI
// database. This must never inherit the preview config's Hyperdrive binding.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackHostname } from "../lib/loopback-hosts.mjs";

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
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Kit Worker fixture accepts only loopback Postgres hosts");
  }
}

function tail(value, limit = 4000) {
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

function listen(child, origin, getLog, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolveReady, reject) => {
    const attempt = async () => {
      if (child.exitCode !== null) {
        reject(
          new Error(
            `Wrangler dev exited before ready (exit ${child.exitCode}). Worker output:\n${tail(getLog())}`,
          ),
        );
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
        reject(
          new Error(
            `Timed out waiting for the generated Kit Worker. Worker output:\n${tail(getLog())}`,
          ),
        );
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
    DISCORD_GUILD_ID: "326474832151838730",
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
    stdio: ["ignore", "pipe", "pipe"],
  },
);
// Buffer Worker output and print it only on failure: --log-level error keeps
// success quiet while a red check still shows the cause.
let workerLog = "";
child.on("error", (error) => {
  workerLog += `\n${error.message}`;
});
for (const stream of [child.stdout, child.stderr]) {
  stream?.on("data", (data) => {
    workerLog += data.toString();
  });
}
let failed = false;
try {
  await listen(child, origin, () => workerLog);

  const archive = await fetch(`${origin}/events/past`);
  const archiveHtml = await archive.text();
  assert.equal(
    archive.status,
    200,
    `generated Worker serves the archive route (got ${archive.status}; body: ${archiveHtml.slice(0, 500)})`,
  );
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

  // Content leaves keep #808's zero-stylesheet contract on the served
  // worker. The unit parity harness renders pages without +layout.svelte,
  // so it passes while the served page carries the layout asset link —
  // this is the built-worker pin: both Kit-owned leaves answer from Kit
  // with the exact inlined leaf block (its sha256 equals the
  // CSP-allowlisted hash), zero stylesheet links, and the Hono body class
  // so the leaf block owns the canvas.
  const leafModule = await readFile(join(repo, "src", "leaf-critical-css.ts"), "utf8");
  const leafHash = leafModule.match(/LEAF_CRITICAL_CSS_SHA256: string = "([^"]+)"/)?.[1];
  assert.ok(leafHash, "leaf CSS hash is generated");
  for (const leaf of ["/about", "/faq"]) {
    const page = await fetch(`${origin}${leaf}`);
    const html = await page.text();
    assert.equal(page.status, 200, `generated Worker serves ${leaf} (got ${page.status})`);
    assert.equal(page.headers.get("x-two-renderer"), "kit", `${leaf} is Kit-owned`);
    assert.equal(
      page.headers.get("cache-control"),
      "public, max-age=3600",
      `${leaf} keeps the Hono cache contract`,
    );
    // includes, not a RegExp: the base64 hash carries +/=, which read as
    // quantifiers and never match literally.
    assert.ok(
      (page.headers.get("content-security-policy") ?? "").includes(`'sha256-${leafHash}'`),
      `${leaf} CSP allowlists the leaf style hash`,
    );
    assert.doesNotMatch(html, /rel="stylesheet"/, `${leaf} ships zero stylesheet links`);
    assert.match(
      html,
      /<body[^>]*class="[^"]*base-theme content-theme/,
      `${leaf} paints the Hono body class`,
    );
    const styleBlocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    assert.equal(styleBlocks.length, 1, `${leaf} inlines exactly one style block`);
    const servedHash = createHash("sha256").update(styleBlocks[0][1], "utf8").digest("base64");
    assert.equal(servedHash, leafHash, `${leaf} style block matches the CSP hash`);
  }
  console.log("PASS generated Worker content-leaf zero-stylesheet contract");

  const api = await fetch(`${origin}/api/agent-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(api.status, 404, "disabled fixture ingress fails closed at the Hono API route");
  assert.equal((await api.json()).reason, "ingress_disabled");
  console.log("PASS generated Worker Hono API dispatch");

  // Kit's built-in form CSRF check is disabled, so a cross-origin form POST
  // must reach the hardened gate: the Hono cross_origin 403 with security
  // headers, never Kit's bare "Cross-site POST form submissions" text.
  const form = await fetch(`${origin}/events/past`, {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "title=x",
  });
  assert.equal(form.status, 403, "cross-origin form POST is refused");
  assert.match(form.headers.get("content-type") ?? "", /application\/json/);
  const formBody = await form.json();
  assert.equal(formBody.error, "cross_origin");
  assert.equal(typeof formBody.request_id, "string");
  assert.ok(formBody.request_id.length > 0, "cross-origin refusal carries request_id");
  assert.deepEqual(Object.keys(formBody).sort(), ["error", "request_id"]);
  assert.equal(form.headers.get("cache-control"), "no-store, private");
  assert.match(
    form.headers.get("content-security-policy") ?? "",
    /default-src 'self'/,
    "form refusal leaves hardened",
  );
  console.log("PASS generated Worker cross-origin form POST refusal");

  const asset = await fetch(`${origin}/favicon.ico`);
  assert.equal(asset.status, 200, "public assets are served through the generated Worker");
  assert.match(
    asset.headers.get("content-type") ?? "",
    /image\/x-icon|image\/vnd\.microsoft\.icon/,
  );
  assert.ok((await asset.arrayBuffer()).byteLength > 0, "favicon response has a body");
  console.log("PASS generated Worker public asset response");
} catch (error) {
  failed = true;
  throw error;
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveExit) => setTimeout(resolveExit, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // Print after the child has exited so the Worker's own error log has
  // flushed into the buffer; printing in catch races the log.
  if (failed) process.stderr.write(`Generated Kit Worker output:\n${tail(workerLog)}\n`);
  await rm(scratch, { recursive: true, force: true });
}
