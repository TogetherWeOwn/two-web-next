// Observes the built Kit Worker's fatal renderer, without a runtime change.
// Fixture design credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3.
// An esbuild hook substitution throws inside Kit; loopback Wrangler uses a minimal
// environment, no test route, database, queue, tail consumer or remote credentials.
// After `npm run build --prefix web`, run:
//   node --import tsx --test ci/kit-worker-fatal.test.mjs
// KIT_WORKER_FATAL_EVIDENCE_DIR (default artifacts/kit-worker-fatal) receives
// sanitized observations and checks even on failure, never bodies or worker logs.
// Cases that never ran cannot produce a passing record.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
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
const assets = join(web, ".svelte-kit/cloudflare");
const entry = join(assets, "_worker.js");
const wrangler = join(web, "node_modules/.bin/wrangler");
const APEX = "togetherweown.com";
const PRIVATE_DETAIL = "TEST_ONLY_PRIVATE_DETAIL";
const HOSTILE_REQUEST_ID = "hostile-client-request-id";
const READY_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const EVIDENCE_VERSION = 1;
const SUITE = "Kit built Worker fatal path";

const HOOKS_FILTER = /[\\/]output[\\/]server[\\/]entries[\\/]hooks\.server\.js$/;
const REPLACEMENT_HOOKS = [
  `export const handle = () => { throw new Error(${JSON.stringify(PRIVATE_DETAIL)}); };`,
  'export const handleError = () => ({ message: "Internal Error" });',
  "",
].join("\n");

const FALLBACK_STYLE_ELEMENT = `<style>${KIT_FALLBACK_INLINE_STYLE}</style>`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const evidence = {
  version: EVIDENCE_VERSION,
  sourceSha: process.env.GITHUB_SHA ?? null,
  headSha: process.env.KIT_WORKER_FATAL_HEAD_SHA ?? null,
  entry: relative(repo, entry).replaceAll("\\", "/"),
  entrySha256: null,
  replacedHooks: 0,
  setupError: null,
  cases: {},
};
let fixture;

async function bundleWorker(outfile) {
  let replaced = 0;
  const plugin = {
    name: "test-only-throwing-hooks",
    setup(b) {
      b.onLoad({ filter: HOOKS_FILTER }, (args) => {
        assert.match(readFileSync(args.path, "utf8"), /\bhandle\b/, "built hooks export handle");
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
  evidence.replacedHooks = replaced;
  assert.equal(replaced, 1, `expected exactly 1 hooks replacement, got ${replaced}`);
  assert.ok(readFileSync(outfile, "utf8").includes(PRIVATE_DETAIL), "replacement is bundled");
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
function send(port, { method = "GET", path, accept, headers = {} }) {
  return new Promise((ok, fail) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: APEX, ...(accept ? { accept } : {}), ...headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", fail);
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          ok({ status: res.statusCode, headers: res.headers, body });
        });
      },
    );
    req.on("error", fail);
    req.end();
  });
}

async function startFixture() {
  for (const path of [entry, wrangler]) {
    assert.ok(statSync(path).isFile(), `missing ${relative(repo, path)}`);
  }
  evidence.entrySha256 = sha256(readFileSync(entry));
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-worker-fatal-"),
  );
  const state = { scratch, child: undefined, port: 0, spawnFailed: false };
  fixture = state;
  const bundle = join(scratch, "worker.mjs");
  await bundleWorker(bundle);
  state.port = await unusedPort();
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
  const args = ["dev", "--config", config, "--local", "--ip", "127.0.0.1"];
  args.push("--port", String(state.port), "--inspector-port", "0", "--log-level", "error");
  const child = spawn(wrangler, args, {
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
  });
  state.child = child;
  child.on("error", () => {
    state.spawnFailed = true;
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    assert.equal(state.spawnFailed, false, "wrangler dev failed to spawn");
    assert.equal(child.exitCode, null, `wrangler dev exited early (${child.exitCode})`);
    try {
      if ((await send(state.port, { path: "/_app/version.json" })).status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out waiting for wrangler dev");
}

async function stopFixture() {
  if (!fixture) return;
  const { child, scratch } = fixture;
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  rmSync(scratch, { recursive: true, force: true });
}

const one = (value) => (Array.isArray(value) ? value.join(", ") : value);

function observe(response) {
  const { headers } = response;
  const csp = one(headers["content-security-policy"]) ?? "";
  const leaks =
    response.body.includes(PRIVATE_DETAIL) ||
    Object.values(headers).some((v) => String(one(v)).includes(PRIVATE_DETAIL)) ||
    /\n\s+at\s/.test(response.body);
  const requestId = one(headers["x-request-id"]);
  return {
    status: response.status,
    headerNames: Object.keys(headers).sort(),
    contentType: one(headers["content-type"]) ?? null,
    cacheControl: one(headers["cache-control"]) ?? null,
    contentSecurityPolicy: csp || null,
    robotsTag: one(headers["x-robots-tag"]) ?? null,
    requestIdSafe: safeRequestId(requestId) !== undefined,
    requestIdEchoesClient: requestId === HOSTILE_REQUEST_ID,
    bodyLength: response.body.length,
    hasFallbackStyleElement: response.body.includes(FALLBACK_STYLE_ELEMENT),
    cspHasFallbackHash: csp.includes(KIT_FALLBACK_STYLE_SHA256),
    leaksSyntheticDetail: leaks,
  };
}

// Every contract check is evaluated and recorded before any assertion fires.
function envelopeChecks(response, path, method, { fallback }) {
  const checks = {};
  const base = securityHeadersFor({ path, method }, "");
  for (const [name, value] of base) {
    const got = one(response.headers[name.toLowerCase()]);
    const expected =
      name === "Content-Security-Policy" && fallback ? withKitFallbackStyleCsp(value) : value;
    checks[`header ${name}`] = got === expected;
  }
  const cache = (one(response.headers["cache-control"]) ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase());
  checks["cache-control private and no-store"] =
    cache.includes("private") && cache.includes("no-store");
  const requestId = one(response.headers["x-request-id"]);
  checks["x-request-id safe and not client-controlled"] =
    safeRequestId(requestId) !== undefined && requestId !== HOSTILE_REQUEST_ID;
  checks["no synthetic exception detail"] = !observe(response).leaksSyntheticDetail;
  return checks;
}

const CASES = {
  "GET /about html": { method: "GET", accept: "text/html", fallback: true },
  "GET /about json": { method: "GET", accept: "application/json", fallback: false },
  "HEAD /about": { method: "HEAD", accept: "text/html", fallback: false },
};

function caseChecks(response, { method, accept, fallback }) {
  const contentType = one(response.headers["content-type"]) ?? "";
  const csp = one(response.headers["content-security-policy"]) ?? "";
  const checks = {
    "status 500": response.status === 500,
    ...envelopeChecks(response, "/about", method, { fallback }),
  };
  if (accept === "application/json") {
    let parsed = null;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = null;
    }
    checks["content-type application/json"] = /application\/json/i.test(contentType);
    checks["fatal JSON representation"] = parsed?.message === "Internal Error";
  } else {
    checks["content-type text/html"] = /^text\/html\b/i.test(contentType);
    if (method === "HEAD") checks["empty body"] = response.body === "";
    else {
      checks["fatal page rendered"] = /500:\s*Page unavailable/.test(response.body);
      checks["exact fallback style element"] = response.body.includes(FALLBACK_STYLE_ELEMENT);
    }
  }
  if (!fallback) checks["no fallback style hash"] = !csp.includes(KIT_FALLBACK_STYLE_SHA256);
  return checks;
}

function writeEvidence() {
  const dir = resolve(
    repo,
    process.env.KIT_WORKER_FATAL_EVIDENCE_DIR ?? "artifacts/kit-worker-fatal",
  );
  mkdirSync(dir, { recursive: true });
  const complete = Object.keys(CASES).every((label) => evidence.cases[label]?.checks);
  const passed =
    complete &&
    evidence.setupError === null &&
    Object.values(evidence.cases).every((c) => Object.values(c.checks).every(Boolean));
  writeFileSync(
    join(dir, "kit-worker-fatal-evidence.json"),
    `${JSON.stringify({ ...evidence, passed }, null, 2)}\n`,
  );
}

describe(SUITE, { timeout: 240_000 }, () => {
  before(async () => {
    try {
      await startFixture();
    } catch {
      evidence.setupError = "fixture_setup_failed";
      throw new Error("fixture_setup_failed");
    }
  });

  after(async () => {
    try {
      await stopFixture();
    } finally {
      writeEvidence();
    }
  });

  for (const [label, spec] of Object.entries(CASES)) {
    test(label, async () => {
      const record = { observed: null, checks: null, error: null };
      evidence.cases[label] = record;
      try {
        const response = await send(fixture.port, {
          path: "/about",
          method: spec.method,
          accept: spec.accept,
          headers: { "x-request-id": HOSTILE_REQUEST_ID },
        });
        record.observed = observe(response);
        record.checks = caseChecks(response, spec);
      } catch {
        record.error = "case_execution_failed";
        throw new Error("case_execution_failed");
      }
      const failed = Object.entries(record.checks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      assert.deepEqual(failed, [], `${label}: failed contract checks`);
    });
  }
});
