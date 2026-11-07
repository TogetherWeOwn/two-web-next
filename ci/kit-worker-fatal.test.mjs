#!/usr/bin/env node
// Fatal-path proof for the production Kit Worker entry (web/worker.js).
//
// The built Kit hooks module is swapped, inside an esbuild BUNDLE written to a
// private scratch directory, for one whose handle() throws. Kit then answers
// through its fatal error renderer, outside hooks.handle, which is exactly the
// response protectKitWorkerResponse must envelope. Nothing under web/ or src/
// is modified; the replacement happens in the esbuild onLoad hook only.
//
// Run after `npm run build --prefix web`:
//   node --import tsx ci/kit-worker-fatal.test.mjs
// Optional KIT_WORKER_FATAL_EVIDENCE_DIR receives kit-worker-fatal-evidence.json
// (statuses, header names and booleans only; never bodies).
//
// No database, queue, tail consumer, route or remote credential is configured,
// and the child gets a minimal environment instead of process.env.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  KIT_FALLBACK_INLINE_STYLE,
  KIT_FALLBACK_STYLE_SHA256,
  securityHeadersFor,
  withKitFallbackStyleCsp,
} from "../src/headers.ts";
import { safeRequestId } from "../src/request-log.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(repo, "web");
const entry = join(web, "worker.js");
const assets = join(web, ".svelte-kit/cloudflare");
const wrangler = join(web, "node_modules/.bin/wrangler");
const APEX = "togetherweown.com";
const PRIVATE_DETAIL = "TEST_ONLY_PRIVATE_DETAIL";
const READY_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const JOB_TIMEOUT_MS = 180_000;
const EVIDENCE_VERSION = 1;

const HOOKS_FILTER = /[\\/]output[\\/]server[\\/]entries[\\/]hooks\.server\.js$/;
const REPLACEMENT_HOOKS = [
  `export const handle = () => { throw new Error(${JSON.stringify(PRIVATE_DETAIL)}); };`,
  'export const handleError = () => ({ message: "Internal Error" });',
  "",
].join("\n");

const tail = (value, limit = 4000) => (value.length > limit ? `…${value.slice(-limit)}` : value);

function requireBuilt() {
  for (const path of [join(assets, "_worker.js"), wrangler]) {
    let ok = false;
    try {
      ok = statSync(path).isFile();
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(`kit-worker-fatal: missing ${path} (npm ci and npm run build --prefix web)`);
    }
  }
}

// Bundle web/worker.js with only the built hooks entry replaced. Fails closed
// unless exactly one module was replaced and it declared the names Kit reads.
async function bundleWorker(outfile) {
  let replaced = 0;
  const plugin = {
    name: "test-only-throwing-hooks",
    setup(b) {
      b.onLoad({ filter: HOOKS_FILTER }, (args) => {
        const original = readFileSync(args.path, "utf8");
        assert.match(original, /\bhandle\b/, "built hooks entry must export handle");
        replaced += 1;
        return { contents: REPLACEMENT_HOOKS, loader: "js", resolveDir: dirname(args.path) };
      });
    },
  };
  const result = await build({
    entryPoints: [entry],
    outfile,
    absWorkingDir: repo,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
    plugins: [plugin],
    logLevel: "silent",
    write: true,
  });
  assert.equal(result.errors.length, 0, "esbuild reported errors");
  assert.equal(replaced, 1, `expected exactly 1 hooks replacement, got ${replaced}`);
  const bundled = readFileSync(outfile, "utf8");
  assert.ok(bundled.includes(PRIVATE_DETAIL), "replacement hooks are in the bundle");
  return { replacedHooks: replaced };
}

async function unusedPort() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const { port } = server.address();
  await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())));
  return port;
}

// node:http so the Host header can be the apex while connecting to loopback.
function send(port, { method = "GET", path, accept }) {
  return new Promise((ok, fail) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: APEX, ...(accept ? { accept } : {}) },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", fail);
        res.on("end", () =>
          ok({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", fail);
    req.end();
  });
}

async function waitReady(child, port, getLog) {
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early (${child.exitCode}):\n${tail(getLog())}`);
    }
    try {
      const response = await send(port, { path: "/_app/version.json" });
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for wrangler dev:\n${tail(getLog())}`);
}

function expectEnvelope(label, response, path, method, { fallback }) {
  const { headers } = response;
  const base = securityHeadersFor({ path, method }, "");
  for (const [name, value] of base) {
    const got = headers[name.toLowerCase()];
    assert.ok(got, `${label}: ${name} present`);
    if (name === "Content-Security-Policy") {
      const expected = fallback ? withKitFallbackStyleCsp(value) : value;
      assert.equal(got, expected, `${label}: CSP is ${fallback ? "widened" : "base"}`);
    } else {
      assert.equal(got, value, `${label}: ${name}`);
    }
  }
  assert.equal(headers["x-two-renderer"], "kit", `${label}: renderer marker`);
  assert.equal(headers["x-two-origin"], "two-web-next", `${label}: origin marker`);
  assert.equal(headers["cache-control"], "no-store", `${label}: no-store`);
  assert.ok(safeRequestId(headers["x-request-id"]), `${label}: safe x-request-id`);
  assert.ok(
    [undefined, "noindex, nofollow"].includes(headers["x-robots-tag"]),
    `${label}: robots tag is absent or noindex`,
  );
}

const summary = (response) => ({
  status: response.status,
  headerNames: Object.keys(response.headers).sort(),
  contentType: response.headers["content-type"] ?? null,
  bodyLength: response.body.length,
  hasFallbackStyle: response.body.includes(`<style>${KIT_FALLBACK_INLINE_STYLE}</style>`),
  cspHasFallbackHash: (response.headers["content-security-policy"] ?? "").includes(
    KIT_FALLBACK_STYLE_SHA256,
  ),
  leaksPrivateDetail:
    response.body.includes(PRIVATE_DETAIL) ||
    Object.values(response.headers).some((v) => String(v).includes(PRIVATE_DETAIL)),
});

async function runCases(port) {
  const evidence = {};
  for (const path of ["/about", "/events"]) {
    const label = `GET ${path} html`;
    const response = await send(port, { path, accept: "text/html" });
    assert.equal(response.status, 500, `${label}: status`);
    assert.equal(response.headers["content-type"], "text/html; charset=UTF-8", `${label}: type`);
    expectEnvelope(label, response, path, "GET", { fallback: true });
    assert.ok(
      response.body.includes(`<style>${KIT_FALLBACK_INLINE_STYLE}</style>`),
      `${label}: body carries the exact fallback style`,
    );
    assert.ok(!summary(response).leaksPrivateDetail, `${label}: no private detail`);
    evidence[label] = summary(response);
  }

  const json = await send(port, { path: "/about", accept: "application/json" });
  assert.equal(json.status, 500, "GET /about json: status");
  assert.match(json.headers["content-type"] ?? "", /application\/json/, "json content type");
  expectEnvelope("GET /about json", json, "/about", "GET", { fallback: false });
  assert.ok(
    !(json.headers["content-security-policy"] ?? "").includes(KIT_FALLBACK_STYLE_SHA256),
    "JSON error is not widened with the fallback hash",
  );
  assert.ok(!summary(json).leaksPrivateDetail, "GET /about json: no private detail");
  evidence["GET /about json"] = summary(json);

  const head = await send(port, { method: "HEAD", path: "/about", accept: "text/html" });
  assert.equal(head.status, 500, "HEAD /about: status");
  assert.equal(head.body, "", "HEAD /about: null body on the wire");
  // Kit 3.1.1 instance.js strips HEAD bodies before adapter.fetch returns,
  // so the outer boundary sees no style element and must keep the base CSP.
  expectEnvelope("HEAD /about", head, "/about", "HEAD", { fallback: false });
  evidence["HEAD /about"] = summary(head);
  return evidence;
}

const evidence = { version: EVIDENCE_VERSION, sourceSha: process.env.GITHUB_SHA, passed: false };
const scratch = mkdtempSync(
  join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-worker-fatal-"),
);
let child;
let workerLog = "";
let failed = false;
const watchdog = setTimeout(() => {
  process.stderr.write(`kit-worker-fatal: exceeded ${JOB_TIMEOUT_MS}ms\n`);
  child?.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}, JOB_TIMEOUT_MS);
try {
  requireBuilt();
  const bundle = join(scratch, "worker.mjs");
  const { replacedHooks } = await bundleWorker(bundle);
  const port = await unusedPort();
  const home = join(scratch, "home");
  mkdirSync(home);
  const config = join(scratch, "wrangler.jsonc");
  writeFileSync(
    config,
    JSON.stringify({
      name: "two-web-kit-worker-fatal-fixture",
      main: bundle,
      compatibility_date: "2026-09-29",
      compatibility_flags: ["nodejs_compat"],
      assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
      vars: {
        APP_URL: `https://${APEX}`,
        FEATURED_IMAGE_HOSTS: "",
        KIT_ROUTE_ARCHIVE: "false",
        KIT_ROUTE_STATIC: "false",
      },
    }),
  );
  child = spawn(
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
      // Minimal env: no inherited Cloudflare, database or Discord credentials.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.on("error", (error) => {
    workerLog += `\n${error.message}`;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (data) => {
      workerLog += data.toString();
    });
  }
  await waitReady(child, port, () => workerLog);
  const cases = await runCases(port);
  Object.assign(evidence, { appUrl: `https://${APEX}`, replacedHooks, cases, passed: true });
  console.log("PASS built Kit fatal path is enveloped by web/worker.js");
} catch (error) {
  failed = true;
  throw error;
} finally {
  clearTimeout(watchdog);
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (failed) process.stderr.write(`Fatal-path worker output:\n${tail(workerLog)}\n`);
  rmSync(scratch, { recursive: true, force: true });
  const evidenceDir = process.env.KIT_WORKER_FATAL_EVIDENCE_DIR;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, "kit-worker-fatal-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
  }
}
