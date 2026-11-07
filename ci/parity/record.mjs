#!/usr/bin/env node
// Record route-parity goldens from a Worker build (docs/kit-parity-gates.md,
// "Pure-Hono route parity goldens").
//
//   PARITY_DATABASE_URL=postgres://...@127.0.0.1/... \
//     node --import tsx ci/parity/record.mjs --out <dir> [--runs N] [--config wrangler.jsonc]
//
// The default target is root wrangler.jsonc (main src/worker.ts, pure Hono).
// Each run gets a fresh clone of one migrated, seeded template database and
// its own `wrangler dev --local` process (never `vite dev`), wrapped by
// ci/parity/harness.ts. Runs are written to <dir>/run-<n>; with one run, to <dir>.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { isLoopbackHostname } from "../../lib/loopback-hosts.mjs";
import { readWranglerConfig } from "../wrangler-config.mjs";
import {
  FIXTURE_SECRETS,
  WRONG_QA_TOKEN,
  identityCookies,
  refreshClone,
  seedTemplate,
} from "./fixture.mjs";
import {
  ASSET_ETAG_MASK,
  MASK,
  clientAddress,
  describeBody,
  maskAssetEtag,
  normalizeHeaders,
  stableHex,
} from "./normalize.mjs";
import { goldenJson, packRecording } from "./golden.mjs";
import { buildVectors, loadVectorInputs } from "./vectors.mjs";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Inputs whose git trees decide whether a golden directory still applies. */
export const RUNTIME_INPUTS = [
  "src",
  "public",
  "tail",
  "drizzle",
  "wrangler.jsonc",
  "package-lock.json",
];
export const HARNESS_INPUTS = [
  "ci/parity",
  "e2e/discord-stub.ts",
  "test/fixtures/route-inventory.json",
];
const REQUEST_TIMEOUT_MS = 20_000;

export function requireDisposableDatabase(value) {
  if (!value) throw new Error("PARITY_DATABASE_URL must point to a disposable loopback Postgres");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Route parity accepts only a Postgres URL");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("Route parity accepts only loopback Postgres hosts");
  }
  return url;
}

const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

/** The newest commit that changed a runtime input: the pinned pure-Hono SHA. */
export function runtimePin() {
  return git("log", "-1", "--format=%H", "--", ...RUNTIME_INPUTS);
}

export function inputTrees(ref = "HEAD") {
  return Object.fromEntries(
    [...RUNTIME_INPUTS, ...HARNESS_INPUTS].map((path) => [
      path,
      git("rev-parse", `${ref}:${path}`),
    ]),
  );
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

function send(port, options, body) {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, timeout: REQUEST_TIMEOUT_MS, ...options },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          done({ status: res.statusCode, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }),
        );
        res.on("error", fail);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out: ${options.method} ${options.path}`)));
    req.on("error", fail);
    req.end(body);
  });
}

async function waitReady(port, child, log) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (child.exitCode !== null)
      throw new Error(`wrangler dev exited (${child.exitCode}):\n${log().slice(-4000)}`);
    try {
      const res = await send(port, { method: "GET", path: "/__parity/ready" });
      if (res.status === 200) {
        const ready = JSON.parse(res.body.toString("utf8"));
        if (!ready.randomSeeded) throw new Error("Parity harness could not seed crypto randomness");
        return;
      }
    } catch (error) {
      if (error.message.startsWith("Parity harness")) throw error;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Timed out waiting for wrangler dev:\n${log().slice(-4000)}`);
}

/** A wrangler config in a scratch dir whose entry wraps the target's main with the harness. */
export async function harnessConfig(targetConfig, scratch, databaseUrl) {
  const configPath = isAbsolute(targetConfig) ? targetConfig : join(repo, targetConfig);
  const target = readWranglerConfig(await readFile(configPath, "utf8"));
  const base = dirname(configPath);
  const entry = join(scratch, "parity-entry.ts");
  await writeFile(
    entry,
    [
      `import inner from ${JSON.stringify(resolve(base, target.main))};`,
      `import { parityWorker } from ${JSON.stringify(join(repo, "ci/parity/harness.ts"))};`,
      "export default parityWorker(inner);",
      "",
    ].join("\n"),
  );
  const config = {
    name: "two-web-next-route-parity",
    main: entry,
    compatibility_date: target.compatibility_date,
    compatibility_flags: target.compatibility_flags,
    workers_dev: false,
    ...(target.assets
      ? { assets: { ...target.assets, directory: resolve(base, target.assets.directory) } }
      : {}),
    ...(target.queues ? { queues: { producers: target.queues.producers ?? [] } } : {}),
    // Hyperdrive, version metadata, routes and tail consumers stay out: the
    // database is the disposable clone and the version id would vary per run.
    vars: { ...target.vars, ...FIXTURE_SECRETS, DATABASE_URL: databaseUrl },
  };
  const path = join(scratch, "wrangler.jsonc");
  await writeFile(path, JSON.stringify(config, null, 2));
  return { path, appUrl: config.vars.APP_URL };
}

function requestHeaders(vector, context) {
  const key = `${vector.file}#${vector.id}`;
  const headers = {
    "x-parity-vector": key,
    "x-parity-client": clientAddress(key),
    accept: vector.accept ?? "*/*",
  };
  if (vector.origin) headers.origin = vector.origin;
  if (vector.contentType) headers["content-type"] = vector.contentType;
  if (vector.authorization) headers.authorization = vector.authorization;
  if (vector.qaToken) {
    headers["x-two-qa-auth"] =
      vector.qaToken === "valid" ? FIXTURE_SECRETS.QA_AUTH_TOKEN : WRONG_QA_TOKEN;
  }
  if (vector.identity) headers.cookie = context.cookies[vector.identity];
  if (vector.ifNoneMatch === "*") headers["if-none-match"] = "*";
  else if (vector.ifNoneMatch) {
    const etag = context.etags.get(vector.file) ?? '"parity-no-etag"';
    headers["if-none-match"] =
      vector.ifNoneMatch === "weak" && !etag.startsWith("W/") ? `W/${etag}` : etag;
  }
  return headers;
}

/** What the golden keeps about the request: the variant, never a cookie or token value. */
function requestRecord(vector, headers) {
  const kept = { ...headers };
  delete kept["x-parity-vector"];
  delete kept["x-parity-client"];
  if (kept.cookie) kept.cookie = `<identity:${vector.identity}>`;
  if (kept["x-two-qa-auth"]) kept["x-two-qa-auth"] = `<qa-token:${vector.qaToken}>`;
  // The If-None-Match vectors echo the ETag the target served, so the same mask applies.
  if (kept["if-none-match"]) kept["if-none-match"] = maskAssetEtag(kept["if-none-match"]);
  if (vector.bodyBytes) kept["content-length"] = String(vector.bodyBytes);
  return { method: vector.method, path: vector.path, headers: kept };
}

async function runVector(port, vector, context, tailLabel) {
  const headers = requestHeaders(vector, context);
  let body;
  if (vector.bodyBytes) body = Buffer.alloc(vector.bodyBytes, "a");
  else if (vector.body !== undefined && vector.method !== "GET" && vector.method !== "HEAD") {
    body = Buffer.from(vector.body);
  }
  const options = { method: vector.method, path: vector.path, headers: { ...headers } };
  if (body) options.headers["content-length"] = String(body.length);
  const statuses = [];
  let res;
  for (let i = 0; i < (vector.repeat ?? 1); i++) {
    res = await send(port, options, body);
    statuses.push(res.status);
  }
  const normalized = normalizeHeaders(res.rawHeaders);
  const contentType = normalized.headers["content-type"];
  const requestId = stableHex(`ray:${vector.file}#${vector.id}`);
  const response = {
    status: res.status,
    headers: normalized.headers,
    setCookies: normalized.setCookies,
    body: describeBody(
      vector.method === "HEAD" ? Buffer.alloc(0) : res.body,
      contentType,
      requestId,
    ),
    route: normalized.route,
    tailLabel: tailLabel(normalized.route),
    alerts: normalized.alerts,
    outbound: normalized.outbound,
  };
  if (vector.repeat) response.repeatStatuses = statuses;
  // The plain GET runs before its If-None-Match siblings (vectors.mjs order),
  // so the conditional vectors present the exact validator Hono just sent.
  if (vector.id === "GET") {
    const index = res.rawHeaders.findIndex(
      (value, i) => i % 2 === 0 && value.toLowerCase() === "etag",
    );
    if (index !== -1) context.etags.set(vector.file, res.rawHeaders[index + 1]);
  }
  return { request: requestRecord(vector, headers), response };
}

async function recordRun({
  adminUrl,
  template,
  runIndex,
  targetConfig,
  vectors,
  coverage,
  out,
  tailLabel,
  meta,
}) {
  const admin = postgres(adminUrl.href, { max: 1, onnotice: () => {} });
  const runDb = `${template}_run${runIndex}`;
  await admin.unsafe(`drop database if exists ${runDb}`);
  await admin.unsafe(`create database ${runDb} template ${template}`);
  const runUrl = new URL(adminUrl.href);
  runUrl.pathname = `/${runDb}`;
  const clone = postgres(runUrl.href, { max: 1, onnotice: () => {} });
  await refreshClone(clone);
  await clone.end();

  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "route-parity-"));
  const { path: config } = await harnessConfig(targetConfig, scratch, runUrl.href);
  const port = await unusedPort();
  const child = spawn(
    join(repo, "node_modules/.bin/wrangler"),
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
  let workerLog = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => (workerLog += data));
  try {
    await waitReady(port, child, () => workerLog);
    const context = { cookies: await identityCookies(), etags: new Map() };
    const files = new Map();
    for (const vector of vectors) {
      const record = await runVector(port, vector, context, tailLabel);
      const file = files.get(vector.file) ?? {};
      file[vector.id] = record;
      files.set(vector.file, file);
    }
    await rm(out, { recursive: true, force: true });
    const sorted = new Map(
      [...files].map(([file, records]) => [
        file,
        Object.fromEntries(
          Object.keys(records)
            .sort()
            .map((id) => [id, records[id]]),
        ),
      ]),
    );
    const packed = packRecording(sorted);
    for (const [file, vectors] of packed.files) {
      const target = join(out, `${file}.json`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, goldenJson({ file }, { vectors }));
    }
    await writeFile(join(out, "index.json"), goldenJson(meta, { shared: packed.shared, coverage }));
  } finally {
    child.kill("SIGTERM");
    await new Promise((done) => (child.exitCode !== null ? done() : child.once("exit", done)));
    await rm(scratch, { recursive: true, force: true });
    await admin.unsafe(`drop database if exists ${runDb} with (force)`);
    await admin.end();
  }
  return workerLog;
}

export async function record({ out, runs = 1, targetConfig = "wrangler.jsonc", databaseUrl }) {
  const adminUrl = requireDisposableDatabase(databaseUrl);
  const inputs = await loadVectorInputs(repo);
  const { vectors, coverage } = buildVectors(inputs);
  const { ALERT_ROUTES } = await import(pathToFileURL(join(repo, "tail/worker.ts")).href);
  const tailLabel = (route) => (route ? (ALERT_ROUTES.has(route) ? route : "[redacted]") : null);
  const meta = {
    schema: 1,
    target: targetConfig,
    pinnedSha: runtimePin(),
    inputs: inputTrees(),
    epoch: "2026-07-01T12:00:00.000Z",
    masked: {
      headers: ["date", "x-request-id", "cf-ray"],
      assetEtags: ASSET_ETAG_MASK,
      cookieValues: MASK,
      nonces: MASK,
    },
    vectorCount: vectors.length,
  };
  const template = `two_parity_${process.pid}`;
  const admin = postgres(adminUrl.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${template}`);
    await admin.unsafe(`create database ${template}`);
    const templateUrl = new URL(adminUrl.href);
    templateUrl.pathname = `/${template}`;
    execFileSync(join(repo, "node_modules/.bin/drizzle-kit"), ["migrate"], {
      cwd: repo,
      env: { ...process.env, DATABASE_URL: templateUrl.href },
      stdio: ["ignore", "ignore", "inherit"],
    });
    const seed = postgres(templateUrl.href, { max: 1, onnotice: () => {} });
    await seedTemplate(seed);
    await seed.end();
    const dirs = [];
    for (let run = 1; run <= runs; run++) {
      const dir = runs === 1 ? out : join(out, `run-${run}`);
      await recordRun({
        adminUrl,
        template,
        runIndex: run,
        targetConfig,
        vectors,
        coverage,
        out: dir,
        tailLabel,
        meta,
      });
      console.log(
        `route parity: recorded ${vectors.length} vectors from ${targetConfig} into ${dir}`,
      );
      dirs.push(dir);
    }
    return { dirs, meta };
  } finally {
    await admin.unsafe(`drop database if exists ${template} with (force)`);
    await admin.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      runs: { type: "string", default: "1" },
      config: { type: "string", default: "wrangler.jsonc" },
    },
  });
  if (!values.out) throw new Error("--out <dir> is required");
  await record({
    out: resolve(values.out),
    runs: Number(values.runs),
    targetConfig: values.config,
    databaseUrl: process.env.PARITY_DATABASE_URL,
  });
}
