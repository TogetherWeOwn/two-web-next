#!/usr/bin/env node
// Kit performance budgets: ceilings for the adapter-generated
// Worker bundle and the Kit client assets, mirroring ci/check-bundle-budget.mjs
// enforcement semantics. Exit 0 fits, 1 breach, 2 cannot enforce.
//
// Worker bundle (`_worker.js`) is content-hashed by build, so it gets exact
// raw/gzip ceilings like the island budgets. Kit client assets under
// `_app/immutable` carry content hashes in every filename, so per-file
// ceilings would churn each build: they are budgeted as totals (all JS, all
// CSS) plus a file-count cap, which still fails closed when a new chunk or
// stylesheet appears without review. Raising a ceiling needs an explicit
// decision explaining the growth; never relax a budget to make CI green.
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";

const repoRoot = resolve(new URL("../", import.meta.url).pathname);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkCeilingShape(entry, ceiling) {
  return (
    isObject(ceiling) &&
    Number.isSafeInteger(ceiling.maxRawBytes) &&
    ceiling.maxRawBytes > 0 &&
    Number.isSafeInteger(ceiling.maxGzipBytes) &&
    ceiling.maxGzipBytes > 0
  );
}

export function discoverKitAssets(clientDir) {
  const js = [];
  const css = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(".js")) js.push(full);
      else if (entry.isFile() && full.endsWith(".css")) css.push(full);
    }
  };
  walk(clientDir);
  js.sort();
  css.sort();
  return { js, css };
}

function checkGroupShape(group) {
  return (
    isObject(group) &&
    checkCeilingShape("group", group) &&
    Number.isSafeInteger(group.maxFiles) &&
    group.maxFiles > 0
  );
}

export function run(root = repoRoot, output = console) {
  let budget;
  try {
    budget = JSON.parse(readFileSync(join(root, "ci/kit-perf-budget.json"), "utf8"));
    if (!isObject(budget) || !isObject(budget.worker) || !isObject(budget.client)) {
      throw new Error("budget must have worker and client objects");
    }
    for (const [entry, ceiling] of Object.entries(budget.worker)) {
      if (entry.includes("..") || !checkCeilingShape(entry, ceiling)) {
        throw new Error(`invalid worker entry or ceilings: ${entry}`);
      }
    }
    if (budget.server !== undefined) {
      if (!isObject(budget.server) || !checkGroupShape(budget.server.js)) {
        throw new Error("invalid server.js budget (needs maxRawBytes, maxGzipBytes, maxFiles)");
      }
    }
    for (const key of ["js", "css"]) {
      const group = budget.client[key];
      if (!checkGroupShape(group)) {
        throw new Error(`invalid client.${key} budget (needs maxRawBytes, maxGzipBytes, maxFiles)`);
      }
    }
    if (!Number.isSafeInteger(budget.startup?.maxMs) || budget.startup.maxMs <= 0) {
      throw new Error("startup.maxMs must be a positive integer");
    }
  } catch (error) {
    output.error(`kit perf budget: cannot enforce: ${error.message}`);
    return 2;
  }

  let breaches = 0;
  const workerPath = join(root, "web/.svelte-kit/cloudflare/_worker.js");
  for (const [entry, ceiling] of Object.entries(budget.worker)) {
    const file = entry === "_worker.js" ? workerPath : join(root, entry);
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      output.error(`kit perf budget: ${entry}: missing/unreadable bundle: ${error.message}`);
      breaches += 1;
      continue;
    }
    const raw = bytes.length;
    const gzip = gzipSync(bytes).length;
    if (raw > ceiling.maxRawBytes || gzip > ceiling.maxGzipBytes) {
      output.error(
        `kit perf budget: ${entry}: raw ${raw}/${ceiling.maxRawBytes}B, gzip ${gzip}/${ceiling.maxGzipBytes}B`,
      );
      breaches += 1;
    } else {
      output.log(
        `ok ${entry}: raw ${raw}/${ceiling.maxRawBytes}B, gzip ${gzip}/${ceiling.maxGzipBytes}B`,
      );
    }
  }

  // Server bundle (adapter output, including the Hono catch-all): hashed chunk
  // names would churn per-file ceilings, so it is budgeted as a JS total plus
  // a file-count cap, like the client groups. Sourcemaps (*.js.map) are never
  // served and stay out of the total.
  if (budget.server !== undefined) {
    const serverDir = join(root, "web/.svelte-kit/output/server");
    let serverStat;
    try {
      serverStat = statSync(serverDir);
    } catch {
      serverStat = null;
    }
    if (!serverStat?.isDirectory()) {
      output.error(
        `kit perf budget: missing Kit server output at web/.svelte-kit/output/server (run npm run build --prefix web)`,
      );
      return 2;
    }
    const serverFiles = discoverKitAssets(serverDir).js;
    const group = budget.server.js;
    let raw = 0;
    let gzip = 0;
    for (const file of serverFiles) {
      const bytes = readFileSync(file);
      raw += bytes.length;
      gzip += gzipSync(bytes).length;
    }
    const over = [];
    if (raw > group.maxRawBytes) over.push(`raw ${raw}B over ${group.maxRawBytes}B`);
    if (gzip > group.maxGzipBytes) over.push(`gzip ${gzip}B over ${group.maxGzipBytes}B`);
    if (serverFiles.length > group.maxFiles)
      over.push(`${serverFiles.length} files over ${group.maxFiles}`);
    if (over.length) {
      output.error(`kit perf budget: server js: ${over.join(", ")}`);
      breaches += 1;
    } else {
      output.log(
        `ok server js: ${serverFiles.length}/${group.maxFiles} files, raw ${raw}/${group.maxRawBytes}B, gzip ${gzip}/${group.maxGzipBytes}B`,
      );
    }
  }

  const clientDir = join(root, "web/.svelte-kit/output/client/_app");
  let dirStat;
  try {
    dirStat = statSync(clientDir);
  } catch {
    dirStat = null;
  }
  if (!dirStat?.isDirectory()) {
    output.error(
      `kit perf budget: missing Kit client output at web/.svelte-kit/output/client/_app (run npm run build --prefix web)`,
    );
    return 2;
  }
  const { js, css } = discoverKitAssets(clientDir);
  for (const [key, files] of [
    ["js", js],
    ["css", css],
  ]) {
    const group = budget.client[key];
    let raw = 0;
    let gzip = 0;
    for (const file of files) {
      const bytes = readFileSync(file);
      raw += bytes.length;
      gzip += gzipSync(bytes).length;
    }
    const over = [];
    if (raw > group.maxRawBytes) over.push(`raw ${raw}B over ${group.maxRawBytes}B`);
    if (gzip > group.maxGzipBytes) over.push(`gzip ${gzip}B over ${group.maxGzipBytes}B`);
    if (files.length > group.maxFiles) over.push(`${files.length} files over ${group.maxFiles}`);
    if (over.length) {
      output.error(`kit perf budget: client ${key}: ${over.join(", ")}`);
      breaches += 1;
    } else {
      output.log(
        `ok client ${key}: ${files.length}/${group.maxFiles} files, raw ${raw}/${group.maxRawBytes}B, gzip ${gzip}/${group.maxGzipBytes}B`,
      );
    }
  }
  output.log(
    `kit perf budget: startup ceiling ${budget.startup.maxMs}ms (enforced as the Kit webServer readiness timeout in playwright.kit-parity.config.ts)`,
  );
  if (breaches) return 1;
  output.log("kit perf budget: every Kit asset fits.");
  return 0;
}

function selftest() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-perf-"));
  const quiet = { log() {}, error() {} };
  let cases = 0;
  const check = (name, setup, expected, message) => {
    mkdirSync(join(root, "ci"), { recursive: true });
    mkdirSync(join(root, "web/.svelte-kit/cloudflare"), { recursive: true });
    mkdirSync(join(root, "web/.svelte-kit/output/server/chunks"), { recursive: true });
    mkdirSync(join(root, "web/.svelte-kit/output/client/_app/immutable"), { recursive: true });
    const workerBytes = Buffer.from(`/* worker */\n${"x".repeat(1000)}`);
    const serverBytes = Buffer.from(`/* server chunk */\n${"w".repeat(800)}`);
    const jsBytes = Buffer.from(`console.log(1);\n${"y".repeat(500)}`);
    const cssBytes = Buffer.from(`.a{color:red}\n${"z".repeat(200)}`);
    writeFileSync(join(root, "web/.svelte-kit/cloudflare/_worker.js"), workerBytes);
    writeFileSync(join(root, "web/.svelte-kit/output/server/chunks/a.js"), serverBytes);
    writeFileSync(join(root, "web/.svelte-kit/output/server/a.js.map"), Buffer.from("{}"));
    writeFileSync(join(root, "web/.svelte-kit/output/client/_app/immutable/a.js"), jsBytes);
    writeFileSync(join(root, "web/.svelte-kit/output/client/_app/immutable/a.css"), cssBytes);
    const budget = {
      worker: {
        "_worker.js": {
          maxRawBytes: workerBytes.length,
          maxGzipBytes: gzipSync(workerBytes).length,
        },
      },
      server: {
        js: {
          maxRawBytes: serverBytes.length,
          maxGzipBytes: gzipSync(serverBytes).length,
          maxFiles: 4,
        },
      },
      client: {
        js: { maxRawBytes: jsBytes.length, maxGzipBytes: gzipSync(jsBytes).length, maxFiles: 4 },
        css: { maxRawBytes: cssBytes.length, maxGzipBytes: gzipSync(cssBytes).length, maxFiles: 4 },
      },
      startup: { maxMs: 30_000 },
    };
    writeFileSync(join(root, "ci/kit-perf-budget.json"), JSON.stringify(budget));
    setup({ root, workerBytes, jsBytes, cssBytes, budget });
    const errors = [];
    const code = run(root, {
      log() {},
      error(text) {
        errors.push(text);
      },
    });
    assert.equal(code, expected, `${name}: got ${code}: ${errors.join("; ")}`);
    if (message)
      assert.ok(
        errors.some((text) => text.includes(message)),
        `${name}: missing diagnostic ${message}`,
      );
    cases += 1;
    console.log(`PASS ${name}`);
  };
  const save = (root, budget) =>
    writeFileSync(join(root, "ci/kit-perf-budget.json"), JSON.stringify(budget));
  check("fitting budgets pass (sourcemaps excluded from the server total)", () => {}, 0);
  check(
    "worker breach fails",
    ({ root, budget }) => {
      budget.worker["_worker.js"].maxRawBytes -= 1;
      save(root, budget);
    },
    1,
    "_worker.js",
  );
  check(
    "server breach fails",
    ({ root, budget }) => {
      budget.server.js.maxGzipBytes -= 1;
      save(root, budget);
    },
    1,
    "server js",
  );
  check(
    "unbudgeted chunk still counted in totals",
    ({ root }) => {
      writeFileSync(
        join(root, "web/.svelte-kit/output/client/_app/immutable/b.js"),
        Buffer.from("x".repeat(100000)),
      );
    },
    1,
    "client js",
  );
  check(
    "missing worker bundle fails",
    ({ root }) => {
      rmSync(join(root, "web/.svelte-kit/cloudflare/_worker.js"));
    },
    1,
    "_worker.js",
  );
  check(
    "missing budget file cannot enforce",
    ({ root }) => {
      writeFileSync(join(root, "ci/kit-perf-budget.json"), "{");
    },
    2,
    "cannot enforce",
  );
  void quiet;
  console.log(`kit perf budget selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , ...args] = process.argv;
  if (args.length === 1 && args[0] === "--selftest") {
    process.exitCode = selftest();
  } else if (args.length === 0) {
    process.exitCode = run();
  } else {
    console.error("Usage: node ci/check-kit-perf.mjs [--selftest]");
    process.exitCode = 2;
  }
}
