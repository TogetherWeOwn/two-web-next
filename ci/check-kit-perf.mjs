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
  existsSync,
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
  const failures = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      failures.push({
        path: dir,
        code: error?.code ?? "UNKNOWN",
        message: error?.message ?? String(error),
      });
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
  return { js, css, incomplete: failures.length > 0, failures };
}

function formatEnumerationDetail(failures) {
  const shown = failures.slice(0, 3).map((failure) => {
    const path = failure.path.length > 260 ? `${failure.path.slice(0, 260)}…` : failure.path;
    return `${path} (${failure.code})`;
  });
  const extra = failures.length > shown.length ? ` (+${failures.length - shown.length} more)` : "";
  return shown.length ? `: ${shown.join("; ")}${extra}` : "";
}

function checkGroupShape(group) {
  return (
    isObject(group) &&
    checkCeilingShape("group", group) &&
    Number.isSafeInteger(group.maxFiles) &&
    group.maxFiles > 0
  );
}

const BUDGET_DIR = "ci/kit-perf-budgets";
const NOTE_NAME = /^[1-9]\d*\.json$/;
const DELTA_FIELDS = ["maxRawBytes", "maxGzipBytes", "maxFiles"];

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label}: unreadable or invalid JSON: ${error.message}`);
  }
}

// Folds one <pr>.json note into the running ceilings. A note holds signed
// integer deltas against base.json (the same field names, `note` carries the
// reason). It may touch only ceilings the base already declares, so it can
// move a budget but never invent, retarget or relax the startup bound.
function applyNote(budget, name, note) {
  const fail = (message) => {
    throw new Error(`${BUDGET_DIR}/${name}: ${message}`);
  };
  if (!isObject(note)) fail("must be a JSON object");
  if (typeof note.note !== "string" || note.note.trim() === "") {
    fail('needs a non-empty "note" saying why the ceilings move');
  }
  for (const key of Object.keys(note)) {
    if (!["note", "worker", "server", "client"].includes(key)) fail(`unknown key "${key}"`);
  }
  const apply = (target, delta, path, fields) => {
    if (!isObject(delta)) fail(`${path} must be an object`);
    if (!isObject(target)) fail(`${path} is not a ceiling the base budget declares`);
    for (const [field, value] of Object.entries(delta)) {
      if (!fields.includes(field) || !(field in target)) {
        fail(`${path}.${field} is not a ceiling the base budget declares`);
      }
      if (!Number.isSafeInteger(value)) fail(`${path}.${field} must be an integer delta`);
      target[field] += value;
    }
  };
  for (const [entry, delta] of Object.entries(note.worker ?? {})) {
    apply(budget.worker[entry], delta, `worker.${entry}`, ["maxRawBytes", "maxGzipBytes"]);
  }
  if (note.server !== undefined) {
    if (!isObject(note.server)) fail("server must be an object");
    for (const [group, delta] of Object.entries(note.server)) {
      apply(budget.server?.[group], delta, `server.${group}`, DELTA_FIELDS);
    }
  }
  if (note.client !== undefined) {
    if (!isObject(note.client)) fail("client must be an object");
    for (const [group, delta] of Object.entries(note.client)) {
      apply(budget.client[group], delta, `client.${group}`, DELTA_FIELDS);
    }
  }
}

// The enforced budget is ci/kit-perf-budgets/base.json plus the sum of every
// ci/kit-perf-budgets/<pr>.json note. Each PR that moves a ceiling adds its
// own note file instead of editing one shared file, so concurrent PRs never
// touch the same path. The old shared ci/kit-perf-budget.json must stay gone.
export function loadBudget(root = repoRoot) {
  if (existsSync(join(root, "ci/kit-perf-budget.json"))) {
    throw new Error(
      `ci/kit-perf-budget.json is retired; keep ceilings in ${BUDGET_DIR}/base.json and add a ${BUDGET_DIR}/<pr>.json note instead`,
    );
  }
  const dir = join(root, BUDGET_DIR);
  const budget = readJson(join(dir, "base.json"), `${BUDGET_DIR}/base.json`);
  if (!isObject(budget) || !isObject(budget.worker) || !isObject(budget.client)) {
    throw new Error("budget must have worker and client objects");
  }
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "base.json")
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || (a < b ? -1 : 1));
  for (const name of names) {
    if (!NOTE_NAME.test(name)) {
      throw new Error(`${BUDGET_DIR}/${name}: note files are named <pr number>.json`);
    }
    applyNote(budget, name, readJson(join(dir, name), `${BUDGET_DIR}/${name}`));
  }
  return { budget, notes: names };
}

export function run(root = repoRoot, output = console) {
  let budget;
  let notes;
  try {
    ({ budget, notes } = loadBudget(root));
    for (const [entry, ceiling] of Object.entries(budget.worker)) {
      if (entry.includes("..") || !checkCeilingShape(entry, ceiling)) {
        throw new Error(`invalid worker entry or ceilings (after summing notes): ${entry}`);
      }
    }
    if (budget.server !== undefined) {
      if (!isObject(budget.server) || !checkGroupShape(budget.server.js)) {
        throw new Error(
          "invalid server.js budget after summing notes (needs positive maxRawBytes, maxGzipBytes, maxFiles)",
        );
      }
    }
    for (const key of ["js", "css"]) {
      const group = budget.client[key];
      if (!checkGroupShape(group)) {
        throw new Error(
          `invalid client.${key} budget after summing notes (needs positive maxRawBytes, maxGzipBytes, maxFiles)`,
        );
      }
    }
    if (!Number.isSafeInteger(budget.startup?.maxMs) || budget.startup.maxMs <= 0) {
      throw new Error("startup.maxMs must be a positive integer");
    }
  } catch (error) {
    output.error(`kit perf budget: cannot enforce: ${error.message}`);
    return 2;
  }
  output.log(
    `kit perf budget: ceilings = ${BUDGET_DIR}/base.json + ${notes.length} note${notes.length === 1 ? "" : "s"}`,
  );

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
    const serverDiscovery = discoverKitAssets(serverDir);
    if (serverDiscovery.incomplete) {
      output.error(
        `kit perf budget: server js: cannot enforce: incomplete enumeration${formatEnumerationDetail(serverDiscovery.failures)}`,
      );
      return 2;
    }
    const serverFiles = serverDiscovery.js;
    if (serverFiles.length === 0) {
      output.error(
        `kit perf budget: server js: cannot enforce: no server JS files under web/.svelte-kit/output/server (run npm run build --prefix web)`,
      );
      return 2;
    }
    const group = budget.server.js;
    let raw = 0;
    let gzip = 0;
    for (const file of serverFiles) {
      let bytes;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        output.error(
          `kit perf budget: server js: cannot enforce: unreadable file ${file}: ${error.message}`,
        );
        return 2;
      }
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
  const clientDiscovery = discoverKitAssets(clientDir);
  if (clientDiscovery.incomplete) {
    output.error(
      `kit perf budget: client js/css: cannot enforce: incomplete enumeration${formatEnumerationDetail(clientDiscovery.failures)}`,
    );
    return 2;
  }
  const { js, css } = clientDiscovery;
  for (const [key, files] of [
    ["js", js],
    ["css", css],
  ]) {
    if (files.length === 0) {
      output.error(
        `kit perf budget: client ${key}: cannot enforce: no client ${key} files under web/.svelte-kit/output/client/_app (run npm run build --prefix web)`,
      );
      return 2;
    }
    const group = budget.client[key];
    let raw = 0;
    let gzip = 0;
    for (const file of files) {
      let bytes;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        output.error(
          `kit perf budget: client ${key}: cannot enforce: unreadable file ${file}: ${error.message}`,
        );
        return 2;
      }
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
    for (const dir of ["ci", "web"]) rmSync(join(root, dir), { recursive: true, force: true });
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
    mkdirSync(join(root, BUDGET_DIR), { recursive: true });
    writeFileSync(join(root, BUDGET_DIR, "base.json"), JSON.stringify(budget));
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
    writeFileSync(join(root, BUDGET_DIR, "base.json"), JSON.stringify(budget));
  const addNote = (root, name, note) =>
    writeFileSync(join(root, BUDGET_DIR, name), JSON.stringify(note));
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
      writeFileSync(join(root, BUDGET_DIR, "base.json"), "{");
    },
    2,
    "cannot enforce",
  );
  check(
    "a note's delta lets a base breach pass",
    ({ root, budget }) => {
      budget.client.js.maxRawBytes -= 10;
      save(root, budget);
      addNote(root, "1.json", { note: "selftest", client: { js: { maxRawBytes: 10 } } });
    },
    0,
  );
  check(
    "the summed ceiling is enforced",
    ({ root, budget }) => {
      budget.client.js.maxRawBytes -= 10;
      save(root, budget);
      addNote(root, "1.json", { note: "selftest", client: { js: { maxRawBytes: 9 } } });
    },
    1,
    "client js",
  );
  check(
    "a malformed note cannot enforce",
    ({ root }) => {
      addNote(root, "x.json", { note: "selftest" });
    },
    2,
    "x.json",
  );
  check(
    "the retired shared budget file cannot return",
    ({ root }) => {
      writeFileSync(join(root, "ci/kit-perf-budget.json"), "{}");
    },
    2,
    "retired",
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
