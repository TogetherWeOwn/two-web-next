#!/usr/bin/env node
// Exercise the adapter-generated Kit Worker on loopback with the disposable CI
// database. This must never inherit the preview config's Hyperdrive binding.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isLoopbackHostname } from "../lib/loopback-hosts.mjs";
import { STAGING_STATIC_DOCUMENT_READY } from "../src/kit-staging-static.ts";
import { assertKitAdminServing, prepareAdminFixture } from "./fixtures/kit-admin-serving.mjs";
import { assertStaticFeedParity } from "./fixtures/kit-static-feed-parity.mjs";
import { expectedMarkerFor, kitHomeHeadingText } from "./kit-parity-gates.mjs";
import { STAGING_ORIGIN } from "./operator-constants.mjs";
import { FIXTURE_SECRETS } from "./parity/fixture.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(repo, "web");
const databaseUrl = process.env.KIT_WORKER_TEST_DATABASE_URL;

async function workerOutput(args) {
  if (args.length === 0) {
    const assets = join(web, ".svelte-kit/cloudflare");
    return { worker: join(assets, "_worker.js"), assets };
  }
  assert.deepEqual(args, ["--installed-output"], "unexpected Kit Worker fixture arguments");
  const { prepareInstalledKitWorker } = await import("./kit-worker-installed-output.mjs");
  return prepareInstalledKitWorker(repo);
}

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
  let lastStatus = "no response";
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
          redirect: "manual",
          signal: AbortSignal.timeout(1_000),
        });
        lastStatus = `HTTP ${response.status}`;
        await response.body?.cancel();
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
            `Timed out waiting for ${origin}/favicon.ico (${lastStatus}). Worker output:\n${tail(getLog())}`,
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
const args = process.argv.slice(2);
const publicVoiceBrowser = args[0] === "--installed-output" && args[1] === "--public-voice-browser";
if (publicVoiceBrowser) args.splice(1, 1);
const { worker, assets } = await workerOutput(args);
const scratch = await mkdtemp(
  join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-worker-e2e-"),
);
const wrangler = join(web, "node_modules/.bin/wrangler");
const workers = [];

// Start one loopback Worker. The generated Kit Worker and the direct Hono
// Worker (src/worker.ts, the same app Kit's catch-all forwards to) share the
// fixture database and vars within each pair.
async function startWorker(name, main, assetsDirectory, sessionSecret, vars, liveHub = false) {
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const config = join(scratch, `${name}.wrangler.jsonc`);
  const configBody = {
    name: `two-web-${name}-ci-fixture`,
    main,
    compatibility_date: "2026-09-29",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: assetsDirectory, binding: "ASSETS", run_worker_first: true },
    ...(liveHub
      ? {
          durable_objects: { bindings: [{ name: "DISCORD_LIVE_HUB", class_name: "LiveGuildHub" }] },
          migrations: [{ tag: "live-v1", new_sqlite_classes: ["LiveGuildHub"] }],
        }
      : {}),
    vars: {
      APP_URL: origin,
      DATABASE_URL: databaseUrl,
      ...(sessionSecret ? { SESSION_SECRET: sessionSecret } : {}),
      FEATURED_IMAGE_HOSTS: "",
      DISCORD_CLIENT_ID: "ci-fixture-client",
      DISCORD_CLIENT_SECRET: "ci-fixture-secret",
      DISCORD_BOT_TOKEN: "ci-fixture-token",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_MODERATOR_ROLE_IDS: "",
      DISCORD_INVITE_URL: "https://example.invalid/invite",
      AGENT_EVENTS_ENABLED: "false",
      ...vars,
    },
  };
  await writeFile(config, JSON.stringify(configBody));
  if (args.length) console.log(`Launching loopback ${name} Worker`);
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
  const worker = { name, child, origin, log: "", stopped: false };
  worker.closed = new Promise((done) => {
    child.once("close", () => {
      worker.stopped = true;
      done();
    });
  });
  workers.push(worker);
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
let failed = false;
try {
  const kit = await startWorker("kit", worker, assets, undefined, undefined, args.length > 0);
  const hono = await startWorker("hono", join(repo, "src/worker.ts"), join(repo, "public"));
  const origin = kit.origin;
  await Promise.all([
    listen(kit.child, kit.origin, () => kit.log),
    listen(hono.child, hono.origin, () => hono.log),
  ]);

  if (args.length) {
    const disabled = await fetch(`${origin}/internal/discord-live/v1/ingest`, {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(disabled.status, 503, "the installed live route defaults off");
    assert.equal(disabled.headers.get("cache-control"), "no-store");
    assert.equal(await disabled.text(), "");
    const disabledSocket = await fetch(`${origin}/api/discord-live/v1`);
    assert.equal(disabledSocket.status, 503, "the installed socket route defaults off");
    await disabledSocket.body?.cancel();

    const entry = join(scratch, "kit-live.mjs");
    await writeFile(
      entry,
      `import { withEnv } from "cloudflare:workers";
import worker, { LiveGuildHub as InstalledHub } from ${JSON.stringify(worker)};
import { fixtureHub, controlledFetch } from ${JSON.stringify(fileURLToPath(new URL("./fixtures/kit-live-source.mjs", import.meta.url)))};
export const LiveGuildHub = fixtureHub(InstalledHub);
export default { fetch: controlledFetch(fetch) };
function fetch(request, env, context) {
  const incoming = new URL(request.url);
  if (env.KIT_PARITY_FIXTURE_EVENT_DETAIL === "true" && incoming.pathname.startsWith("/e/")) {
    // Event document ownership requires loopback. Socket and ingest requests
    // still use the separate HTTPS origin required by the installed live hub.
    const bindings = { ...env, APP_URL: incoming.origin };
    return withEnv(bindings, () => worker.fetch(request, bindings, context));
  }
  const url = new URL(incoming.pathname + incoming.search, env.APP_URL);
  const secure = new Request(url, request);
  secure.headers.set("host", url.host);
  // Map the browser's loopback origin to the synthetic HTTPS origin only.
  if (secure.headers.get("origin") === incoming.origin) secure.headers.set("origin", url.origin);
  return worker.fetch(secure, env, context);
}\n`,
    );
    const { LIVE_FIXTURE_GUILD, verifyPublicFanout } = await import(
      "./fixtures/kit-live-fanout.mjs"
    );
    const secret = FIXTURE_SECRETS.SESSION_SECRET;
    const liveVars = {
      APP_URL: "https://kit-live.invalid",
      BOT_ENDPOINT_URL: "https://bot-live.invalid",
      DISCORD_GUILD_ID: LIVE_FIXTURE_GUILD,
      DISCORD_LIVE_INGEST_ENABLED: "true",
      DISCORD_LIVE_SOCKET_ENABLED: "true",
      DISCORD_LIVE_PUBLIC_VOICE_ROOM_IDS: "10,11",
      DISCORD_LIVE_INGEST_KEY_ID: "fixture-ingest",
      DISCORD_LIVE_INGEST_SECRET: "fixture-ingest-value",
      DISCORD_LIVE_SNAPSHOT_KEY_ID: "fixture-snapshot",
      DISCORD_LIVE_SNAPSHOT_SECRET: "fixture-snapshot-value",
    };
    if (publicVoiceBrowser) {
      // Run the documents against separate persisted Workers so the hub starts
      // cold and the disabled fixture has a working session bridge.
      const browserVars = { ...liveVars, KIT_PARITY_FIXTURE_EVENT_DETAIL: "true" };
      const off = await startWorker(
        "kit-voice-off",
        entry,
        assets,
        secret,
        { ...browserVars, DISCORD_LIVE_SOCKET_ENABLED: undefined },
        true,
      );
      await listen(off.child, off.origin, () => off.log);
      const enabled = await startWorker("kit-voice", entry, assets, secret, browserVars, true);
      await listen(enabled.child, enabled.origin, () => enabled.log);
      const { verifyKitPublicVoice } = await import("./fixtures/kit-public-voice.mjs");
      await verifyKitPublicVoice(off.origin, enabled.origin, databaseUrl, secret);
    }
    const live = await startWorker("kit-live", entry, assets, secret, liveVars, true);
    await listen(live.child, live.origin, () => live.log);
    const { verifyKitLiveSocket } = await import("./kit-live-socket.mjs");
    await verifyKitLiveSocket(live.origin, "https://kit-live.invalid", databaseUrl, secret);
    await verifyPublicFanout(live.origin, "https://kit-live.invalid", databaseUrl, secret);
  }

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

  const manifest = await readFile(join(repo, "src/route-ownership.ts"), "utf8");
  const homeMarker = expectedMarkerFor(manifest, "/");
  const home = await fetch(`${origin}/`);
  const homeHtml = await home.text();
  assert.equal(home.status, 200, "guest home GET renders");
  assert.equal(home.headers.get("x-two-renderer"), homeMarker, "home GET follows the manifest");
  assert.equal(home.headers.get("cache-control"), "private, no-store");
  if (homeMarker === "kit") assert.equal(kitHomeHeadingText(homeHtml), "The lobby is open.");
  else assert.match(homeHtml, /<h1 id="home-heading">The lobby is open\.<\/h1>/);
  // No session-secret binding: a guest still gets the safe invite fallback.
  assert.match(homeHtml, /href="\/discord"[^>]*data-testid="discord-join"/);
  assert.doesNotMatch(homeHtml, /data-testid="join"/);
  assert.doesNotMatch(homeHtml, /data-testid="(?:home-standing|home-event-own-rsvp)"/);
  const headHome = await fetch(`${origin}/`, { method: "HEAD" });
  assert.equal(headHome.status, home.status);
  assert.equal(headHome.headers.get("x-two-renderer"), homeMarker, "home HEAD follows GET");
  assert.equal(headHome.headers.get("cache-control"), "private, no-store");
  assert.equal(await headHome.text(), "", "HEAD has no response body");
  console.log("PASS generated Worker guest home GET and HEAD");

  // Content leaves keep #808's zero-stylesheet contract on the served
  // worker. The unit parity harness renders pages without +layout.svelte,
  // so it passes while the served page carries the layout asset link —
  // this is the built-worker pin: the content leaves answer from Kit
  // with the exact inlined leaf block (its sha256 equals the
  // CSP-allowlisted hash), zero stylesheet links, and the Hono body class
  // so the leaf block owns the canvas.
  const leafModule = await readFile(join(repo, "src", "leaf-critical-css.ts"), "utf8");
  const leafHash = leafModule.match(/LEAF_CRITICAL_CSS_SHA256: string = "([^"]+)"/)?.[1];
  assert.ok(leafHash, "leaf CSS hash is generated");
  async function assertContentLeaf(page, leaf) {
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
    return html;
  }
  for (const leaf of ["/about", "/faq"]) {
    await assertContentLeaf(await fetch(`${origin}${leaf}`), leaf);
  }
  console.log("PASS generated Worker content-leaf zero-stylesheet contract");

  // The host check requires the Request URL and Host header to agree with
  // APP_URL. Rewrite both inside the fixture, then call the generated Worker
  // directly so the HTTP connection never leaves loopback.
  const stagingEntry = join(scratch, "kit-static.mjs");
  await writeFile(
    stagingEntry,
    `import worker from ${JSON.stringify(worker)};
export default {
  fetch(request, env, context) {
    const local = new URL(request.url);
    const url = new URL(env.APP_URL);
    url.pathname = local.pathname;
    url.search = local.search;
    const stagedRequest = new Request(url, request);
    stagedRequest.headers.set("host", url.host);
    return worker.fetch(stagedRequest, env, context);
  },
};\n`,
  );
  const staging = await startWorker("kit-static", stagingEntry, assets, undefined, {
    APP_URL: STAGING_ORIGIN,
    DATABASE_URL: undefined,
    KIT_ROUTE_ARCHIVE: "true",
    KIT_ROUTE_STATIC: "true",
  });
  await listen(staging.child, staging.origin, () => staging.log);
  for (const [leaf, marker] of [
    ["/about", 'data-testid="about-facts"'],
    ["/faq", 'data-testid="faq-list"'],
    ["/privacy", 'data-testid="privacy-policy"'],
    ["/rules", 'data-testid="rules-list"'],
  ]) {
    const page = await fetch(`${staging.origin}${leaf}`, { redirect: "manual" });
    if (STAGING_STATIC_DOCUMENT_READY.get(leaf) === false) {
      assert.equal(page.status, 200, `${leaf} still serves a document after rollback`);
      assert.equal(page.headers.get("x-two-renderer"), null, `${leaf} rolls back to Hono`);
      assert.ok((await page.text()).includes(marker), `${leaf} retains its content on Hono`);
      continue;
    }
    const html = await assertContentLeaf(page, leaf);
    assert.ok(html.includes(marker), `${leaf} has server-rendered content`);
    assert.doesNotMatch(html, /<script\b/i, `${leaf} ships no JavaScript`);
    assert.equal(page.headers.get("set-cookie"), null, `${leaf} does not set a session cookie`);
    const csp = page.headers.get("content-security-policy")?.split("; ") ?? [];
    assert.ok(csp.includes("script-src 'self'"), `${leaf} retains strict script CSP`);
    assert.ok(
      csp.includes(`style-src 'self' 'sha256-${leafHash}'`),
      `${leaf} retains strict style CSP`,
    );
  }
  console.log("PASS generated Worker archive-static SSR without database, session, or JavaScript");

  // Exercise the post-hook Kit ETag rewrite in the built Worker, not only the
  // framework-free dispatch. Every security header must survive revalidation.
  const ray = "0123456789abcdef";
  const baseline = await fetch(`${origin}/about`, { headers: { "cf-ray": ray } });
  const etag = baseline.headers.get("etag");
  assert.ok(etag, "Kit leaf has an ETag");
  for (const validator of [etag, `W/${etag}`]) {
    const conditional = await fetch(`${origin}/about`, {
      headers: { "cf-ray": ray, "if-none-match": validator },
    });
    assert.equal(conditional.status, 304, `${validator}: Kit returns 304`);
    assert.equal(await conditional.text(), "", "304 has no body");
    for (const name of [
      "etag",
      "cache-control",
      "content-security-policy",
      "x-content-type-options",
      "x-frame-options",
      "referrer-policy",
      "permissions-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
      "x-two-renderer",
    ]) {
      assert.ok(baseline.headers.get(name), `baseline includes ${name}`);
      assert.equal(
        conditional.headers.get(name),
        baseline.headers.get(name),
        `${name} survives 304`,
      );
    }
    assert.ok(conditional.headers.get("x-request-id"), "304 retains its request id");
  }
  const miss = await fetch(`${origin}/about`, { headers: { "if-none-match": '"not-the-tag"' } });
  assert.equal(miss.status, 200, "nonmatching validator keeps the representation");
  for (const validator of [null, '"not-the-tag"']) {
    const init = validator ? { headers: { "if-none-match": validator } } : {};
    const [direct, fallback] = await Promise.all([
      fetch(`${hono.origin}/llms.txt`, init),
      fetch(`${origin}/llms.txt`, init),
    ]);
    assert.equal(fallback.status, direct.status, "Hono fallback status is unchanged");
    assert.equal(
      (await fallback.text()).replaceAll(origin, "ORIGIN"),
      (await direct.text()).replaceAll(hono.origin, "ORIGIN"),
      "Hono fallback body is unchanged apart from its configured origin",
    );
    assert.equal(
      fallback.headers.get("content-security-policy"),
      direct.headers.get("content-security-policy"),
    );
  }
  console.log("PASS generated Worker conditional header preservation");

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

  // Ordinary CI exercises the stock build here. The installed-output mode
  // also runs in cutover qualification and has its own fixture contract.
  if (args.length === 0) {
    const { assertPublicAssetParity } = await import("./fixtures/kit-public-asset-parity.mjs");
    await assertPublicAssetParity({ honoOrigin: hono.origin, kitOrigin: origin });
    console.log("PASS public stylesheet, pinned font and missing font response parity");
  }

  // These files are generated by Kit and have no Hono representation. Compare
  // only the security headers against Hono's response at the same URL, not
  // their status or body. The existing kit-header-parity test pins this block
  // to securityHeadersFor; the runtime check exercises the adapter boundary.
  const headerSource = await readFile(join(web, "_headers"), "utf8");
  const appBlock = headerSource.split(/^\/_app\/\*\s*$/m)[1];
  assert.ok(appBlock, "source contains the adapter asset header block");
  const assetHeaders = appBlock
    .split("\n")
    .filter((line) => /^\s{2}[^\s#][^:]*:/.test(line))
    .map((line) => line.trim().split(":", 1)[0].toLowerCase())
    .filter((name) => name !== "x-robots-tag");
  assert.ok(assetHeaders.includes("content-security-policy"), "asset policy includes CSP");
  assert.equal(new Set(assetHeaders).size, assetHeaders.length, "asset headers are unique");
  function assertAssetHeaders(direct, built, label) {
    for (const name of assetHeaders) {
      const expected = direct.get(name);
      const actual = built.get(name);
      assert.ok(expected, `${label}: Hono is missing ${name}`);
      assert.ok(actual, `${label}: Kit is missing ${name}`);
      assert.equal(actual, expected, `${label}: ${name}`);
    }
  }
  // Neither one-sided nor joint absence may pass as equal.
  const fullHeaders = new Headers(assetHeaders.map((name) => [name, "present"]));
  const missingHeaders = new Headers(fullHeaders);
  missingHeaders.delete("content-security-policy");
  assert.throws(() => assertAssetHeaders(fullHeaders, missingHeaders, "negative control"));
  assert.throws(() => assertAssetHeaders(missingHeaders, missingHeaders, "negative control"));

  async function firstImmutable(directory, prefix = "/_app/immutable") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        const nested = await firstImmutable(join(directory, entry.name), path);
        if (nested) return nested;
      } else if (entry.isFile()) return path;
    }
    return null;
  }
  const immutable = await firstImmutable(join(assets, "_app/immutable"));
  assert.ok(immutable, "adapter build contains an immutable asset");
  for (const path of [immutable, "/_app/version.json"]) {
    const get = await fetch(`${origin}${path}`);
    assert.equal(get.status, 200, `${path}: generated asset exists`);
    const etag = get.headers.get("etag");
    assert.ok(etag, `${path}: generated asset has an ETag`);
    for (const [method, validator] of [
      ["GET", null],
      ["HEAD", null],
      ["GET", etag],
      ["HEAD", etag],
      ["GET", '"not-the-asset-tag"'],
      ["POST", null],
      ["OPTIONS", null],
    ]) {
      const init = {
        method,
        redirect: "manual",
        headers: validator ? { "if-none-match": validator } : {},
      };
      const [direct, built] = await Promise.all([
        fetch(`${hono.origin}${path}`, init),
        fetch(`${origin}${path}`, init),
      ]);
      const label = `${method} ${path} ${validator ?? "unconditional"}`;
      if (["GET", "HEAD"].includes(method)) {
        assert.equal(built.status, validator === etag ? 304 : 200, `${label}: asset status`);
      }
      assertAssetHeaders(direct.headers, built.headers, label);
      await Promise.all([direct.arrayBuffer(), built.arrayBuffer()]);
    }
  }
  console.log("PASS generated Worker adapter asset security headers");

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
    "x-two-renderer",
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

  const secret = FIXTURE_SECRETS.SESSION_SECRET;
  const honoWithSession = await startWorker(
    "hono-session",
    join(repo, "src/worker.ts"),
    join(repo, "public"),
    secret,
  );
  const kitWithSession = await startWorker("kit-session", worker, assets, secret);
  await Promise.all(
    [honoWithSession, kitWithSession].map((instance) =>
      listen(instance.child, instance.origin, () => instance.log),
    ),
  );

  if (!args.length) {
    const profile = await startWorker("kit-profile-write", worker, assets, secret, {
      KIT_ROUTE_PROFILE_WRITES: "true",
    });
    await listen(profile.child, profile.origin, () => profile.log);
    const { assertKitProfileWriteParity } = await import("./fixtures/kit-profile-write-parity.mjs");
    await assertKitProfileWriteParity({
      kit: profile.origin,
      off: kitWithSession.origin,
      hono: honoWithSession.origin,
      databaseUrl,
      secret,
    });
  }

  if (args.length) {
    const entry = join(scratch, "kit-admin.mjs");
    const vars = await prepareAdminFixture(worker, entry);
    const admin = await startWorker("kit-admin", entry, assets, secret, vars);
    await listen(admin.child, admin.origin, () => admin.log);
    await assertKitAdminServing({
      kit: admin,
      off: kitWithSession,
      hono: honoWithSession,
      databaseUrl,
    });

    async function observeDataRedirect(worker, path) {
      const response = await fetch(`${worker.origin}${path}`, { redirect: "manual" });
      assert.equal(response.status, 302, `${path}: Hono guest redirect`);
      assert.equal(response.headers.get("location"), "/auth/discord", `${path}: login location`);
      const cookies = response.headers.getSetCookie();
      assert.equal(cookies.length, 1, `${path}: one intended-login cookie`);
      assert.ok(
        cookies[0].startsWith(`__Host-two_login_intended=${encodeURIComponent(path)}.`),
        `${path}: cookie carries the original path and query`,
      );
      assert.equal(response.headers.get("x-two-renderer"), null, `${path}: not a Kit render`);
      const requestId = response.headers.get("x-request-id");
      assert.ok(requestId, `${path}: request correlation survives`);
      const headers = [...SECURITY_HEADERS, "vary"].map((name) =>
        normalize(response.headers.get(name) ?? "", worker, requestId),
      );
      return { headers, cookies, body: await response.text() };
    }

    for (const path of ["/admin/__data.json?tab=events", "/members/__data.json"]) {
      const [direct, installed] = await Promise.all([
        observeDataRedirect(honoWithSession, path),
        observeDataRedirect(kitWithSession, path),
      ]);
      assert.deepEqual(installed, direct, `${path}: installed facade preserves Hono response`);
    }
    console.log("PASS installed Worker preserves Hono data redirects");

    const kitData = await fetch(`${kitWithSession.origin}/admin/join-attempts/__data.json`, {
      redirect: "manual",
    });
    assert.equal(kitData.status, 200, "Kit-owned data redirect remains a JSON response");
    assert.deepEqual(await kitData.json(), {
      type: "redirect",
      status: 302,
      location: "/auth/discord?next=%2Fadmin%2Fjoin-attempts",
    });
    console.log("PASS installed Worker preserves Kit-owned data redirects");
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
  await assertParity("POST / stays with Hono", "/", {
    method: "POST",
    headers: jsonHeaders,
    body: "{}",
  });
  const postApiX = await assertParity("POST /api/x/", "/api/x/", {
    method: "POST",
    headers: jsonHeaders,
    body: "{}",
  });
  assert.equal(postApiX.status, 404, "POST /api/x/ is an unknown API path answered by Hono");
  assert.match(postApiX.headers["content-type"] ?? "", /text\/html/);
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

  // With the feed binding absent, the reserved version read and its method,
  // slash and data variants still reach the direct Hono owner.
  for (const [method, path, expected] of [
    ["GET", "/version?probe=admission", 200],
    ["HEAD", "/version", 200],
    ["POST", "/version", 404],
    ["GET", "/version/", 404],
    ["GET", "/version/__data.json", 404],
  ]) {
    const label = `API families off: ${method} ${path}`;
    const result = await assertParity(label, path, { method });
    assert.equal(result.status, expected, label);
    assert.equal(result.headers["x-two-renderer"], undefined, `${label}: Hono owns the response`);
  }
  console.log("PASS generated Worker reserved method/path parity with API families off");

  await assertStaticFeedParity({
    hono: honoWithSession,
    kit: kitWithSession,
    databaseUrl,
    startKit: async (name, vars) => {
      const instance = await startWorker(
        name,
        worker,
        assets,
        FIXTURE_SECRETS.SESSION_SECRET,
        vars,
      );
      await listen(instance.child, instance.origin, () => instance.log);
      return instance;
    },
    startSecurityTxtPair: async () => {
      const appUrl = "https://policy.example.test";
      const [direct, enabled] = await Promise.all(
        [
          ["hono-policy", join(repo, "src/worker.ts"), join(repo, "public"), undefined],
          ["kit-policy", worker, assets, "true"],
        ].map(async ([name, main, assetsDirectory, flag]) => {
          // Present synthetic HTTPS authorities without leaving loopback.
          const entry = join(scratch, `${name}.mjs`);
          await writeFile(
            entry,
            `import worker from ${JSON.stringify(main)};
export default {
  fetch(request, env, context) {
    const original = new URL(request.url);
    const url = new URL(env.APP_URL);
    const canonicalHost = url.host;
    url.host = request.headers.get("x-fixture-url-host") ?? canonicalHost;
    url.pathname = original.pathname;
    url.search = original.search;
    const rewritten = new Request(url, request);
    rewritten.headers.set("host", request.headers.get("x-fixture-host") ?? canonicalHost);
    rewritten.headers.delete("x-fixture-url-host");
    rewritten.headers.delete("x-fixture-host");
    return worker.fetch(rewritten, env, context);
  },
};\n`,
          );
          const instance = await startWorker(name, entry, assetsDirectory, undefined, {
            APP_URL: appUrl,
            DATABASE_URL: undefined,
            KIT_ROUTE_SECURITY_TXT: flag,
          });
          await listen(instance.child, instance.origin, () => instance.log);
          return instance;
        }),
      );
      return { appUrl, direct, enabled };
    },
  });

  const authEntry = join(scratch, "kit-auth.mjs");
  const authFixture = fileURLToPath(new URL("./fixtures/kit-auth-worker.mjs", import.meta.url));
  await writeFile(
    authEntry,
    `import inner from ${JSON.stringify(worker)};
import { authFixtureWorker } from ${JSON.stringify(authFixture)};
export default authFixtureWorker(inner);\n`,
  );
  const authSecret = FIXTURE_SECRETS.SESSION_SECRET;
  const auth = await startWorker("kit-auth", authEntry, assets, authSecret, {
    DATABASE_URL: undefined,
  });
  await listen(auth.child, auth.origin, () => auth.log);
  const { assertAuthParity } = await import("./fixtures/kit-auth-parity.mjs");
  await assertAuthParity(auth.origin, authSecret, !args.length || publicVoiceBrowser);

  if (args.length) {
    const probePath = "/__fixture/machine-parity";
    const fixture = fileURLToPath(new URL("./fixtures/kit-machine-parity.mjs", import.meta.url));
    for (const { name, main, assetsDirectory } of [
      {
        name: "hono-machine",
        main: join(repo, "src/worker.ts"),
        assetsDirectory: join(repo, "public"),
      },
      { name: "kit-machine", main: worker, assetsDirectory: assets },
    ]) {
      const entry = join(scratch, `${name}.mjs`);
      await writeFile(
        entry,
        `import inner from ${JSON.stringify(main)};
import { machineParityWorker } from ${JSON.stringify(fixture)};
export default machineParityWorker(inner, ${JSON.stringify(probePath)});\n`,
      );
      const instance = await startWorker(name, entry, assetsDirectory, undefined, {
        DATABASE_URL: undefined,
      });
      await listen(instance.child, instance.origin, () => instance.log);
      const response = await fetch(`${instance.origin}${probePath}`, {
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(response.status, 200, `${name}: machine parity probes passed`);
      assert.deepEqual(await response.json(), {
        agentCreate: 201,
        mcpComplete: "eof",
        mcpReaderCancel: "cancelled",
      });
      console.log(`PASS ${name} agent JSON success, MCP SSE EOF and in-Worker reader cancellation`);
    }
    const { verifyKitMachineDisconnect } = await import("./fixtures/kit-machine-disconnect.mjs");
    await verifyKitMachineDisconnect(worker, scratch);
  }
} catch (error) {
  failed = true;
  throw error;
} finally {
  await Promise.all(
    workers.map(async (worker) => {
      if (!worker.stopped) worker.child.kill("SIGTERM");
      await Promise.race([worker.closed, delay(5_000, undefined, { ref: false })]);
      if (!worker.stopped) worker.child.kill("SIGKILL");
      await Promise.race([worker.closed, delay(5_000, undefined, { ref: false })]);
    }),
  );
  // Print after the children close so their output has flushed.
  if (failed) {
    for (const { name, log } of workers)
      process.stderr.write(`${name} Worker output:\n${tail(log)}\n`);
  }
  assert.ok(
    workers.every(({ stopped }) => stopped),
    "loopback Workers did not stop",
  );
  await rm(scratch, { recursive: true, force: true });
  if (args.length) console.log("PASS loopback Workers and scratch cleaned up");
}
