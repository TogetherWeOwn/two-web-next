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
const scratch = await mkdtemp(
  join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-worker-e2e-"),
);
const wrangler = join(web, "node_modules/.bin/wrangler");

// Start one loopback Worker. The generated Kit Worker and the direct Hono
// Worker (src/worker.ts, the same app Kit's catch-all forwards to) share the
// fixture database and vars; only main, assets and the self origin differ.
async function startWorker(name, main, assetsDirectory) {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const config = join(scratch, `${name}.wrangler.jsonc`);
  const configBody = {
    name: `two-web-${name}-ci-fixture`,
    main,
    compatibility_date: "2026-09-29",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: assetsDirectory, binding: "ASSETS", run_worker_first: true },
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
      "--persist-to",
      join(scratch, `${name}-state`),
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
  const worker = { child, origin, log: "" };
  child.on("error", (error) => {
    worker.log += `\n${error.message}`;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (data) => {
      worker.log += data.toString();
    });
  }
  return worker;
}

// Buffer Worker output and print it only on failure: --log-level error keeps
// success quiet while a red check still shows the cause.
const kit = await startWorker("kit", worker, assets);
const hono = await startWorker("hono", join(repo, "src/worker.ts"), join(repo, "public"));
const origin = kit.origin;
const workerLog = () => `Kit Worker:\n${kit.log}\nDirect Hono Worker:\n${hono.log}`;
let failed = false;
try {
  await Promise.all([
    listen(kit.child, kit.origin, () => kit.log),
    listen(hono.child, hono.origin, () => hono.log),
  ]);

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

  // Slash parity: Hono treats /x and /x/ as distinct paths and never
  // redirects between them. The Kit Worker must answer every variant exactly as
  // the direct Hono Worker does on the same fixture database: same status, no
  // redirect, same security headers, same body, with method, body and query
  // forwarded through the catch-all. Origins, request ids and nonces are
  // normalized because they are per-instance or per-request.
  const SECURITY_HEADERS = [
    "content-type",
    "cache-control",
    "location",
    "allow",
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "permissions-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "x-two-origin",
  ];
  const normalize = (value, worker, requestId) => {
    let out = value.split(worker.origin).join("ORIGIN");
    if (requestId) out = out.split(requestId).join("REQUEST_ID");
    return out
      .replace(/nonce-[A-Za-z0-9+/=_-]+/g, "nonce-NONCE")
      .replace(/nonce="[^"]*"/g, 'nonce="NONCE"')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID");
  };
  const shape = (value) =>
    Array.isArray(value)
      ? value.map(shape)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]))
        : typeof value;
  async function observe(worker, path, init, { jsonShape = false } = {}) {
    const requestHeaders = new Headers(init.headers);
    if (
      init.method &&
      !["GET", "HEAD", "OPTIONS"].includes(init.method) &&
      !requestHeaders.has("origin")
    ) {
      requestHeaders.set("origin", worker.origin);
    }
    const response = await fetch(`${worker.origin}${path}`, {
      redirect: "manual",
      ...init,
      headers: requestHeaders,
    });
    const requestId = response.headers.get("x-request-id");
    const text = await response.text();
    const headers = {};
    for (const name of SECURITY_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = normalize(value, worker, requestId);
    }
    let body = normalize(text, worker, requestId);
    if (jsonShape) {
      // /up carries timings and revision data; compare its JSON shape only.
      try {
        body = JSON.stringify(shape(JSON.parse(text)));
      } catch {
        // Not JSON (HEAD or a Hono 404 page): the normalized text stands.
      }
    }
    return { status: response.status, headers, body, hasRequestId: requestId !== null };
  }
  async function assertParity(label, path, init = {}, options = {}) {
    const [fromHono, fromKit] = await Promise.all([
      observe(hono, path, init, options),
      observe(kit, path, init, options),
    ]);
    assert.ok(
      fromHono.status < 300 || fromHono.status >= 400,
      `${label}: direct Hono does not redirect (got ${fromHono.status})`,
    );
    assert.ok(
      fromKit.status < 300 || fromKit.status >= 400,
      `${label}: Kit Worker does not redirect (got ${fromKit.status})`,
    );
    assert.equal(fromKit.status, fromHono.status, `${label}: status matches direct Hono`);
    assert.equal(fromKit.hasRequestId, fromHono.hasRequestId, `${label}: request id presence`);
    assert.deepEqual(fromKit.headers, fromHono.headers, `${label}: headers match direct Hono`);
    assert.equal(fromKit.body, fromHono.body, `${label}: body matches direct Hono`);
    return fromHono;
  }

  // GET and HEAD, with and without a query, across slash variants. /members/
  // and /up/ are non-page paths; the rest are enabled page variants.
  const pagePaths = [
    "/about/",
    "/faq/",
    "/events/",
    "/events/past/",
    "/events/past/?page=2",
    "/members",
    "/members/",
    "/members/?q=a&q=b",
    "/up",
    "/up/",
    "/up/?x=1",
  ];
  for (const path of pagePaths) {
    const isUp = path.startsWith("/up");
    for (const method of ["GET", "HEAD"]) {
      await assertParity(`${method} ${path}`, path, { method }, { jsonShape: isUp });
    }
  }
  console.log("PASS generated Worker GET/HEAD slash parity with direct Hono");

  // The strict (non-redirecting) slash contract must hold for the pages Kit
  // owns: the no-slash form is Kit-owned, the slash form is Hono's answer.
  for (const path of ["/about/", "/faq/", "/events/past/"]) {
    const res = await fetch(`${origin}${path}`, { redirect: "manual" });
    await res.arrayBuffer();
    assert.notEqual(res.headers.get("x-two-renderer"), "kit", `${path} stays with Hono`);
  }
  console.log("PASS generated Worker slash variants stay with Hono");

  // Unsafe methods through slash variants: method must reach Hono, so the
  // method-specific answer (404/405/403) matches the direct Hono Worker.
  const jsonHeaders = { "content-type": "application/json" };
  for (const path of ["/api/x", "/api/x/", "/api/x/?a=1", "/members/", "/up/", "/events/past/"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await assertParity(`${method} ${path}`, path, {
        method,
        headers: jsonHeaders,
        body: JSON.stringify({ probe: path }),
      });
    }
    await assertParity(`OPTIONS ${path}`, path, { method: "OPTIONS" });
  }
  const postApiX = await assertParity("POST /api/x/", "/api/x/", {
    method: "POST",
    headers: jsonHeaders,
    body: "{}",
  });
  assert.equal(postApiX.status, 404, "POST /api/x/ is an unknown API path answered by Hono");
  assert.match(postApiX.headers["content-type"] ?? "", /application\/json/);
  console.log("PASS generated Worker unsafe-method slash parity with direct Hono");

  // Body forwarding: the disabled ingress answers 404 for a small body and 413
  // once the forwarded body exceeds Hono's 32 KiB budget, on both slash forms.
  // A dropped or truncated body could not produce the 413.
  for (const path of ["/api/agent-events", "/api/agent-events/"]) {
    const small = await assertParity(`POST ${path} small`, path, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    });
    const big = await assertParity(`POST ${path} oversized`, path, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ pad: "x".repeat(40 * 1024) }),
    });
    if (path === "/api/agent-events") {
      assert.equal(small.status, 404, "small body reaches the disabled ingress");
      assert.equal(big.status, 413, "oversized body is forwarded and refused by Hono");
    }
  }
  console.log("PASS generated Worker body forwarding");

  // Security controls through the slash variants: the cross-origin gate and
  // its hardened headers apply identically, and no variant redirects.
  for (const path of ["/events/past/", "/api/x/", "/members/", "/events/past/?page=2"]) {
    const refused = await assertParity(`cross-origin POST ${path}`, path, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "title=x",
    });
    assert.equal(refused.status, 403, `${path} cross-origin form POST is refused`);
    assert.match(refused.headers["content-security-policy"] ?? "", /default-src 'self'/);
  }
  console.log("PASS generated Worker slash security parity with direct Hono");

  // Canonical/API boundary: API and reserved prefixes with and without a
  // trailing slash never turn into Kit pages or redirects.
  for (const path of ["/api", "/api/", "/api/events/", "/api/events/past/", "/auth/discord/"]) {
    const res = await assertParity(`GET ${path}`, path);
    assert.ok(res.status < 300 || res.status >= 400, `${path} does not redirect`);
    const viaKit = await fetch(`${origin}${path}`, { redirect: "manual" });
    await viaKit.arrayBuffer();
    assert.notEqual(viaKit.headers.get("x-two-renderer"), "kit", `${path} is never Kit-rendered`);
  }
  console.log("PASS generated Worker canonical/API boundary parity");
} catch (error) {
  failed = true;
  throw error;
} finally {
  for (const { child: proc } of [kit, hono]) proc.kill("SIGTERM");
  await Promise.all(
    [kit, hono].map(async ({ child: proc }) => {
      await Promise.race([
        new Promise((resolveExit) => proc.once("exit", resolveExit)),
        new Promise((resolveExit) => setTimeout(resolveExit, 5_000)),
      ]);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }),
  );
  // Print after the children have exited so the Workers' own error logs have
  // flushed into the buffers; printing in catch races the log.
  if (failed) process.stderr.write(`Generated Kit Worker output:\n${tail(workerLog())}\n`);
  await rm(scratch, { recursive: true, force: true });
}
