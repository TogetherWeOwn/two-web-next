// Proof only: install over stock adapter output on the disposable XFS fixture.
// Fixture design credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import { builtinModules } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import {
  KIT_FALLBACK_INLINE_STYLE,
  KIT_FALLBACK_STYLE_SHA256,
  securityHeadersFor,
  withKitFallbackStyleCsp,
} from "../src/headers.ts";
import { safeRequestId } from "../src/request-log.ts";
import {
  COMPANION_NAME,
  DEFAULT_DIR,
  ENTRY_NAME,
  FACADE_MARKER,
  installWorkerFacade,
} from "../web/scripts/install-worker-facade.mjs";

const PRIVATE_DETAIL = "TEST_ONLY_PRIVATE_DETAIL";
const CLIENT_ID = "fixture-client-request-id";
const STATIC = "/_app/version.json";
const API = "/api/public/join";
const INVITE = "https://discord.gg/fixture";
const artifacts = "artifacts/kit-worker-fatal";
const deps = [join(process.cwd(), "web/node_modules"), join(process.cwd(), "node_modules")];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const size = (bytes) => ({ raw: bytes.length, gzip: gzipSync(bytes).length });
const evidence = { version: 1, cases: {}, hookSubstitutions: 0 };
const runtimes = [];
let assets;
let scratch;
let parity;
let fatal;

async function install() {
  const root = process.env.XFS_FIXTURE_ROOT;
  assert.ok(root && process.env.GITHUB_ACTIONS === "true", "requires hosted XFS fixture");
  assert.equal(fs.statfsSync(root).type, 0x58465342, "fixture mount must be XFS");
  evidence.filesystem = "xfs";
  evidence.checkout = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.match(evidence.checkout, /^[a-f0-9]{40}$/);
  assert.equal(evidence.checkout, process.env.EXPECTED_HEAD_SHA, "requires exact-head checkout");
  // Copy the three siblings to fresh paths so their relative imports still resolve.
  assets = join(root, "cloudflare");
  for (const name of ["cloudflare", "cloudflare-tmp", "output"]) {
    evidence.lastCopyStep = `copy ${name}`;
    const source = join(dirname(DEFAULT_DIR), name);
    assert.ok(fs.lstatSync(source).isDirectory());
    assert.ok(
      fs
        .readdirSync(source, { recursive: true, withFileTypes: true })
        .every((item) => item.isDirectory() || item.isFile()),
      "built tree must not link outside the fixture",
    );
    fs.cpSync(source, join(root, name), { recursive: true, force: false, errorOnExist: true });
  }
  fs.chmodSync(assets, 0o700);
  const entry = join(assets, ENTRY_NAME);
  const original = fs.readFileSync(join(DEFAULT_DIR, ENTRY_NAME));
  evidence.stockAdapterSha256 = sha256(original);
  assert.ok(fs.readFileSync(entry).equals(original), "copy changed the adapter bytes");
  const installed = await installWorkerFacade({ dir: assets });
  const adapter = fs.readFileSync(join(assets, COMPANION_NAME));
  const facade = fs.readFileSync(entry);
  evidence.adapterSha256 = sha256(adapter);
  evidence.entrySha256 = sha256(facade);
  assert.ok(adapter.equals(original), "companion differs from the stock adapter");
  assert.equal(installed.adapterSha256, evidence.adapterSha256);
  assert.equal(installed.facadeSha256, evidence.entrySha256);
  const marker = `${FACADE_MARKER} companion=${COMPANION_NAME} sha256=${evidence.adapterSha256}\n`;
  assert.ok(facade.toString().startsWith(marker), "entry must be the installed facade");
  const pair = { facade: size(facade), adapter: size(adapter) };
  evidence.entryPairBytes = {
    ...pair,
    raw: pair.facade.raw + pair.adapter.raw,
    gzip: pair.facade.gzip + pair.adapter.gzip,
  };
  return entry;
}

const throwingHooks = {
  name: "test-only-throwing-hooks",
  setup(builder) {
    builder.onLoad({ filter: /\/output\/server\/entries\/hooks\.server\.js$/ }, ({ path }) => {
      assert.equal(path, join(dirname(assets), "output/server/entries/hooks.server.js"));
      assert.match(fs.readFileSync(path, "utf8"), /\bhandle\b/);
      evidence.hookSubstitutions += 1;
      return {
        contents: `export const handle = () => { throw new Error("TEST_ONLY_PRIVATE_DETAIL"); }; export const handleError = () => ({ message: "Internal Error" });`,
      };
    });
  },
};

async function bundle(entry, fault) {
  // Resolve packages from the locked workspaces and leave builtins to Wrangler.
  evidence.lastBundle = fault ? "fatal" : "parity";
  const outfile = join(scratch, `${evidence.lastBundle}.mjs`);
  await build({
    entryPoints: [entry],
    outfile,
    nodePaths: deps,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: [...builtinModules, "node:*", "cloudflare:*"],
    logLevel: "silent",
    plugins: fault ? [throwingHooks] : [],
  });
  assert.equal(evidence.hookSubstitutions, Number(fault), "unexpected compiled-hook substitutions");
  assert.equal(fs.readFileSync(outfile, "utf8").includes(PRIVATE_DETAIL), fault);
  return outfile;
}

async function start(name, main) {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())));
  const config = join(scratch, `${name}.jsonc`);
  const origin = `http://127.0.0.1:${port}`;
  fs.writeFileSync(
    config,
    JSON.stringify({
      name,
      main,
      compatibility_date: "2026-09-29",
      compatibility_flags: ["nodejs_compat"],
      assets: { directory: assets, binding: "ASSETS", run_worker_first: true },
      vars: { APP_URL: origin, FEATURED_IMAGE_HOSTS: "", DISCORD_INVITE_URL: INVITE },
    }),
  );
  const args = ["dev", "--config", config, "--local", "--ip", "127.0.0.1"];
  args.push("--port", String(port), "--inspector-port", "0", "--log-level", "error");
  args.push("--persist-to", join(scratch, `${name}-state`));
  const child = spawn(join(deps[0], ".bin/wrangler"), args, {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      WRANGLER_SEND_METRICS: "false",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const readiness = { name };
  evidence.readiness = readiness;
  child.stderr.on("data", (chunk) => {
    const tags = ["Could not resolve", "Error reloading local server", "EADDRINUSE"];
    readiness.wranglerError ??= tags.find((tag) => chunk.includes(tag));
  });
  let exited = false;
  const closed = new Promise((done) =>
    child.once("close", () => {
      exited = true;
      done();
    }),
  );
  child.once("error", () => {
    readiness.spawnFailed = true;
  });
  runtimes.push(async () => {
    if (!exited) child.kill("SIGTERM");
    await Promise.race([closed, delay(5_000, undefined, { ref: false })]);
    if (!exited) child.kill("SIGKILL");
    await Promise.race([closed, delay(5_000, undefined, { ref: false })]);
    assert.ok(exited, `${name} did not stop`);
  });
  // Only loopback transport; never follow an app redirect out of the fixture.
  const fetchWorker = (path, options = {}) =>
    fetch(`${origin}${path}`, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  const deadline = Date.now() + 60_000;
  const expected = fs.readFileSync(join(assets, STATIC), "utf8");
  while (Date.now() < deadline) {
    assert.ok(!readiness.spawnFailed && !exited, `${name} exited before readiness`);
    try {
      const res = await fetchWorker(STATIC);
      readiness.status = res.status;
      if ((await res.text()) === expected && res.status === 200) return fetchWorker;
    } catch (error) {
      if (
        error.name !== "TimeoutError" &&
        !["ECONNREFUSED", "ECONNRESET"].includes(error.cause?.code)
      )
        throw error;
    }
    await delay(250);
  }
  assert.fail(`${name} did not serve the built version asset`);
}

function checkCase(label, run) {
  test(label, async () => {
    evidence.cases[label] = null;
    try {
      evidence.cases[label] = await run();
    } catch {
      throw new Error("fixture case did not complete");
    }
    const checks = evidence.cases[label];
    assert.deepEqual(
      Object.keys(checks).filter((key) => !checks[key]),
      [],
    );
  });
}

function envelope(res, path, method, fallback = false) {
  return Object.fromEntries(
    securityHeadersFor({ path, method }, "").map(([name, value]) => [
      name,
      res.headers.get(name) ===
        (fallback && name === "Content-Security-Policy" ? withKitFallbackStyleCsp(value) : value),
    ]),
  );
}

const fallbackHash = (res) =>
  (res.headers.get("content-security-policy") ?? "").includes(KIT_FALLBACK_STYLE_SHA256);
const mediaType = (res) => res.headers.get("content-type")?.split(";")[0];

async function static200() {
  const res = await parity(STATIC);
  return {
    res,
    checks: {
      "status 200": res.status === 200,
      "JSON media type": mediaType(res) === "application/json",
      "built bytes": Buffer.from(await res.arrayBuffer()).equals(
        fs.readFileSync(join(DEFAULT_DIR, STATIC)),
      ),
      "no fatal hash": !fallbackHash(res),
      validator: Boolean(res.headers.get("etag")),
    },
  };
}

describe("Kit built Worker fatal path", () => {
  before(async () => {
    fs.mkdirSync(artifacts, { recursive: true });
    try {
      const entry = await install();
      scratch = fs.mkdtempSync(join(process.env.RUNNER_TEMP, "kit-fatal-"));
      parity = await start("kit-parity-fixture", await bundle(entry, false));
      fatal = await start("kit-fatal-fixture", await bundle(entry, true));
      assert.equal(sha256(fs.readFileSync(entry)), evidence.entrySha256);
      assert.equal(sha256(fs.readFileSync(join(assets, COMPANION_NAME))), evidence.adapterSha256);
    } catch (error) {
      if (Number.isInteger(error.errno)) evidence.setupErrno = error.errno;
      const missing = /^Could not resolve "([@#.\w][\w@./-]{0,99})"$/.exec(error.errors?.[0]?.text);
      if (error.errors) evidence.bundleError = missing?.[1] ?? "other esbuild error";
      throw new Error(
        error.code === "ERR_ASSERTION" ? error.message.split("\n", 1)[0] : "fixture setup failed",
      );
    }
  });
  after(async () => {
    try {
      const stopped = await Promise.allSettled(runtimes.map((stop) => stop()));
      assert.ok(
        stopped.every((result) => result.status === "fulfilled"),
        "Worker cleanup failed",
      );
      if (scratch) fs.rmSync(scratch, { recursive: true });
      evidence.workerCleanup = true;
    } finally {
      fs.writeFileSync(join(artifacts, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    }
  });

  for (const [label, method, accept] of [
    ["GET /about html", "GET", "text/html"],
    ["GET /about json", "GET", "application/json"],
    ["HEAD /about", "HEAD", "text/html"],
  ]) {
    checkCase(label, async () => {
      const res = await fatal("/about", { method, headers: { accept, "x-request-id": CLIENT_ID } });
      const html = accept === "text/html";
      const fallback = html && method === "GET";
      const requestId = res.headers.get("x-request-id");
      const body = await res.text();
      const cache = (res.headers.get("cache-control") ?? "").split(",").map((part) => part.trim());
      return {
        ...envelope(res, "/about", method, fallback),
        "status 500": res.status === 500,
        "cache private and no-store": cache.includes("private") && cache.includes("no-store"),
        "safe server request ID": safeRequestId(requestId) !== undefined && requestId !== CLIENT_ID,
        "no synthetic exception detail":
          !body.includes(PRIVATE_DETAIL) &&
          !/\n\s+at\s/.test(body) &&
          !Array.from(res.headers.values()).some((v) => v.includes(PRIVATE_DETAIL)),
        "correct media type": mediaType(res) === accept,
        "fallback hash only on GET HTML": fallbackHash(res) === fallback,
        ...(fallback
          ? {
              "fatal page rendered": /500:\s*Page unavailable/.test(body),
              "exact fallback style": body.includes(`<style>${KIT_FALLBACK_INLINE_STYLE}</style>`),
            }
          : html
            ? { "empty HEAD": body === "" }
            : { "generic JSON": JSON.parse(body)?.message === "Internal Error" }),
      };
    });
  }
  checkCase("GET /about Kit success", async () => {
    const res = await parity("/about", { headers: { accept: "text/html" } });
    return {
      ...envelope(res, "/about", "GET"),
      "no fatal hash": !fallbackHash(res),
      "Kit status 200": res.status === 200,
      "Kit renderer marker": res.headers.get("x-two-renderer") === "kit",
      "Kit heading rendered": (await res.text()).includes('id="about-heading"'),
    };
  });
  checkCase("GET /api/public/join Hono dispatch", async () => {
    const res = await parity(API, { headers: { accept: "application/json" } });
    const json = mediaType(res) === "application/json";
    return {
      ...envelope(res, API, "GET"),
      "Hono status 200": res.status === 200,
      "no Kit renderer marker": !res.headers.has("x-two-renderer"),
      "JSON media type": json,
      "join response intact": json && (await res.json())?.invite_url === INVITE,
    };
  });
  checkCase("GET built static asset 200", async () => (await static200()).checks);
  checkCase("GET built static asset conditional 304", async () => {
    const { res, checks } = await static200();
    const etag = res.headers.get("etag");
    if (!etag) return checks;
    const cached = await parity(STATIC, { headers: { "if-none-match": etag } });
    return {
      ...checks,
      "status 304": cached.status === 304,
      "empty body": (await cached.text()) === "",
      "validator preserved": cached.headers.get("etag") === etag,
    };
  });
});
