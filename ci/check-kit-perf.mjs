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
//
// The canonical required measurement inventory lives in
// ci/bundle-inventory.mjs and is validated before any artifact is read: an
// empty, missing, misspelled, substituted or extended plan is an invalid
// plan (exit 2), never a silent drop and never a fits verdict. The missing
// canonical Worker file is missing evidence (exit 2), not a breach.
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
import {
  KIT_CHECK_IDS,
  KIT_CLIENT_DIR,
  KIT_GROUP_IDS,
  KIT_SERVER_DIR,
  KIT_WORKER_ENTRY,
  KIT_WORKER_PATH,
  buildJsonReport,
  cannotEnforceGroups,
  gateUsage,
  parseGateArgs,
  validateKitPlan,
} from "./bundle-inventory.mjs";

const repoRoot = resolve(new URL("../", import.meta.url).pathname);
const SCRIPT_NAME = "ci/check-kit-perf.mjs";
const CHECK_NAME = "kit-perf";

const INVALID_PLAN_NEXT_ACTION =
  "Fix ci/kit-perf-budget.json to match the canonical inventory " +
  "(worker _worker.js, server js, client js and css) defined in ci/bundle-inventory.mjs, " +
  "then rerun node ci/check-kit-perf.mjs";
const REBUILD_NEXT_ACTION =
  "Run npm run build --prefix web, then rerun node ci/check-kit-perf.mjs";
const ENUMERATION_NEXT_ACTION =
  "Rerun npm run build --prefix web and node ci/check-kit-perf.mjs; " +
  "if the named path still fails, inspect permissions on the Kit output dir";

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
  const shown = failures.slice(0, 2).map((failure) => {
    const path = failure.path.length > 120 ? `${failure.path.slice(0, 120)}…` : failure.path;
    return `${path} (${failure.code})`;
  });
  const extra = failures.length > shown.length ? ` (+${failures.length - shown.length} more)` : "";
  return shown.length ? `: ${shown.join("; ")}${extra}` : "";
}

function boundLine(line) {
  return line.length > 500 ? `${line.slice(0, 497)}…` : line;
}

// Measure the Kit inventory at root without printing. Returns the exit code,
// the bounded human lines, the canonical groups, and the fixed error object
// for exit 2. The plan is validated before any artifact is read.
export function measure(root = repoRoot) {
  const logs = [];
  const errors = [];
  const groups = [];
  const fail = (code, error) => ({ code, logs, errors, groups, error });

  let budget;
  try {
    budget = JSON.parse(readFileSync(join(root, "ci/kit-perf-budget.json"), "utf8"));
  } catch (error) {
    errors.push(boundLine(`kit perf budget: cannot enforce: ${error.message}`));
    return fail(2, {
      code: "INVALID_PLAN",
      message: boundLine(`cannot enforce: ${error.message}`),
      nextAction: INVALID_PLAN_NEXT_ACTION,
    });
  }
  const planProblem = validateKitPlan(budget);
  if (planProblem) {
    errors.push(boundLine(`kit perf budget: cannot enforce: ${planProblem}`));
    return fail(2, {
      code: "INVALID_PLAN",
      message: boundLine(`invalid plan: ${planProblem}`),
      nextAction: INVALID_PLAN_NEXT_ACTION,
    });
  }

  let breaches = 0;
  const workerPath = join(root, KIT_WORKER_PATH);
  const ceiling = budget.worker[KIT_WORKER_ENTRY];
  let workerBytes;
  try {
    workerBytes = readFileSync(workerPath);
  } catch (error) {
    errors.push(
      boundLine(
        `kit perf budget: ${KIT_WORKER_ENTRY}: cannot enforce: missing/unreadable bundle: ` +
          `${error.message} (run npm run build --prefix web first)`,
      ),
    );
    return fail(2, {
      code: "MISSING_EVIDENCE",
      message: boundLine(`${KIT_WORKER_ENTRY}: missing/unreadable bundle: ${error.message}`),
      nextAction: REBUILD_NEXT_ACTION,
    });
  }
  const workerRaw = workerBytes.length;
  const workerGzip = gzipSync(workerBytes).length;
  if (workerRaw > ceiling.maxRawBytes || workerGzip > ceiling.maxGzipBytes) {
    errors.push(
      boundLine(
        `kit perf budget: ${KIT_WORKER_ENTRY}: raw ${workerRaw}/${ceiling.maxRawBytes}B, gzip ${workerGzip}/${ceiling.maxGzipBytes}B`,
      ),
    );
    breaches += 1;
    groups.push({
      id: "kit.worker",
      status: "fail",
      checks: [
        {
          id: "kit.worker._worker.js",
          status: "fail",
          rawBytes: workerRaw,
          gzipBytes: workerGzip,
          maxRawBytes: ceiling.maxRawBytes,
          maxGzipBytes: ceiling.maxGzipBytes,
        },
      ],
    });
  } else {
    logs.push(
      boundLine(
        `ok ${KIT_WORKER_ENTRY}: raw ${workerRaw}/${ceiling.maxRawBytes}B, gzip ${workerGzip}/${ceiling.maxGzipBytes}B`,
      ),
    );
    groups.push({
      id: "kit.worker",
      status: "pass",
      checks: [
        {
          id: "kit.worker._worker.js",
          status: "pass",
          rawBytes: workerRaw,
          gzipBytes: workerGzip,
          maxRawBytes: ceiling.maxRawBytes,
          maxGzipBytes: ceiling.maxGzipBytes,
        },
      ],
    });
  }

  // Server bundle (adapter output, including the Hono catch-all): hashed chunk
  // names would churn per-file ceilings, so it is budgeted as a JS total plus
  // a file-count cap, like the client groups. Sourcemaps (*.js.map) are never
  // served and stay out of the total.
  const serverDir = join(root, KIT_SERVER_DIR);
  let serverStat;
  try {
    serverStat = statSync(serverDir);
  } catch {
    serverStat = null;
  }
  if (!serverStat?.isDirectory()) {
    errors.push(
      boundLine(
        `kit perf budget: missing Kit server output at ${KIT_SERVER_DIR} (run npm run build --prefix web)`,
      ),
    );
    return fail(2, {
      code: "MISSING_EVIDENCE",
      message: boundLine(`missing Kit server output at ${KIT_SERVER_DIR}`),
      nextAction: REBUILD_NEXT_ACTION,
    });
  }
  const serverDiscovery = discoverKitAssets(serverDir);
  if (serverDiscovery.incomplete) {
    errors.push(
      boundLine(
        `kit perf budget: server js: cannot enforce: incomplete enumeration${formatEnumerationDetail(serverDiscovery.failures)}`,
      ),
    );
    return fail(2, {
      code: "INCOMPLETE_ENUMERATION",
      message: boundLine(
        `server js: incomplete enumeration${formatEnumerationDetail(serverDiscovery.failures)}`,
      ),
      nextAction: ENUMERATION_NEXT_ACTION,
    });
  }
  const serverFiles = serverDiscovery.js;
  if (serverFiles.length === 0) {
    errors.push(
      boundLine(
        `kit perf budget: server js: cannot enforce: no server JS files under ${KIT_SERVER_DIR} (run npm run build --prefix web)`,
      ),
    );
    return fail(2, {
      code: "MISSING_EVIDENCE",
      message: boundLine(`server js: no server JS files under ${KIT_SERVER_DIR}`),
      nextAction: REBUILD_NEXT_ACTION,
    });
  }
  const serverOutcome = measureGroup(serverFiles, budget.server.js, "server js", logs, errors);
  if (serverOutcome.error) {
    return fail(2, {
      code: "INCOMPLETE_ENUMERATION",
      message: serverOutcome.error,
      nextAction: ENUMERATION_NEXT_ACTION,
    });
  }
  breaches += serverOutcome.breach ? 1 : 0;
  groups.push({
    id: "kit.server.js",
    status: serverOutcome.breach ? "fail" : "pass",
    checks: [
      {
        id: "kit.server.js",
        status: serverOutcome.breach ? "fail" : "pass",
        rawBytes: serverOutcome.raw,
        gzipBytes: serverOutcome.gzip,
        files: serverFiles.length,
        maxRawBytes: budget.server.js.maxRawBytes,
        maxGzipBytes: budget.server.js.maxGzipBytes,
        maxFiles: budget.server.js.maxFiles,
      },
    ],
  });

  const clientDir = join(root, KIT_CLIENT_DIR);
  let dirStat;
  try {
    dirStat = statSync(clientDir);
  } catch {
    dirStat = null;
  }
  if (!dirStat?.isDirectory()) {
    errors.push(
      boundLine(
        `kit perf budget: missing Kit client output at ${KIT_CLIENT_DIR} (run npm run build --prefix web)`,
      ),
    );
    return fail(2, {
      code: "MISSING_EVIDENCE",
      message: boundLine(`missing Kit client output at ${KIT_CLIENT_DIR}`),
      nextAction: REBUILD_NEXT_ACTION,
    });
  }
  const clientDiscovery = discoverKitAssets(clientDir);
  if (clientDiscovery.incomplete) {
    errors.push(
      boundLine(
        `kit perf budget: client js/css: cannot enforce: incomplete enumeration${formatEnumerationDetail(clientDiscovery.failures)}`,
      ),
    );
    return fail(2, {
      code: "INCOMPLETE_ENUMERATION",
      message: boundLine(
        `client js/css: incomplete enumeration${formatEnumerationDetail(clientDiscovery.failures)}`,
      ),
      nextAction: ENUMERATION_NEXT_ACTION,
    });
  }
  const { js, css } = clientDiscovery;
  for (const [key, files] of [
    ["js", js],
    ["css", css],
  ]) {
    if (files.length === 0) {
      errors.push(
        boundLine(
          `kit perf budget: client ${key}: cannot enforce: no client ${key} files under ${KIT_CLIENT_DIR} (run npm run build --prefix web)`,
        ),
      );
      return fail(2, {
        code: "MISSING_EVIDENCE",
        message: boundLine(`client ${key}: no client ${key} files under ${KIT_CLIENT_DIR}`),
        nextAction: REBUILD_NEXT_ACTION,
      });
    }
    const group = budget.client[key];
    const outcome = measureGroup(files, group, `client ${key}`, logs, errors);
    if (outcome.error) {
      return fail(2, {
        code: "INCOMPLETE_ENUMERATION",
        message: outcome.error,
        nextAction: ENUMERATION_NEXT_ACTION,
      });
    }
    breaches += outcome.breach ? 1 : 0;
    groups.push({
      id: `kit.client.${key}`,
      status: outcome.breach ? "fail" : "pass",
      checks: [
        {
          id: `kit.client.${key}`,
          status: outcome.breach ? "fail" : "pass",
          rawBytes: outcome.raw,
          gzipBytes: outcome.gzip,
          files: files.length,
          maxRawBytes: group.maxRawBytes,
          maxGzipBytes: group.maxGzipBytes,
          maxFiles: group.maxFiles,
        },
      ],
    });
  }
  logs.push(
    boundLine(
      `kit perf budget: startup ceiling ${budget.startup.maxMs}ms (enforced as the Kit webServer readiness timeout in playwright.kit-parity.config.ts)`,
    ),
  );
  if (breaches) return fail(1, null);
  logs.push("kit perf budget: every Kit asset fits.");
  return fail(0, null);
}

function measureGroup(files, group, label, logs, errors) {
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      const message = boundLine(
        `kit perf budget: ${label}: cannot enforce: unreadable file ${file}: ${error.message}`,
      );
      errors.push(message);
      return { error: message };
    }
    raw += bytes.length;
    gzip += gzipSync(bytes).length;
  }
  const over = [];
  if (raw > group.maxRawBytes) over.push(`raw ${raw}B over ${group.maxRawBytes}B`);
  if (gzip > group.maxGzipBytes) over.push(`gzip ${gzip}B over ${group.maxGzipBytes}B`);
  if (files.length > group.maxFiles) over.push(`${files.length} files over ${group.maxFiles}`);
  if (over.length) {
    errors.push(boundLine(`kit perf budget: ${label}: ${over.join(", ")}`));
    return { breach: true, raw, gzip };
  }
  logs.push(
    boundLine(
      `ok ${label}: ${files.length}/${group.maxFiles} files, raw ${raw}/${group.maxRawBytes}B, gzip ${gzip}/${group.maxGzipBytes}B`,
    ),
  );
  return { breach: false, raw, gzip };
}

export function run(root = repoRoot, output = console) {
  const result = measure(root);
  for (const line of result.logs) output.log(line);
  for (const line of result.errors) output.error(line);
  return result.code;
}

// Versioned JSON measurement for agents: the canonical groups with stable
// IDs, measured bytes when measured, and a fixed error code plus a concrete
// next_action on exit 2. Human lines stay available for stderr.
export function runJson(root = repoRoot) {
  const result = measure(root);
  const seen = new Set(result.groups.map((group) => group.id));
  const groups = [...result.groups];
  const fallback = cannotEnforceGroups(KIT_GROUP_IDS, KIT_CHECK_IDS);
  for (const group of fallback) {
    if (!seen.has(group.id)) groups.push(group);
  }
  groups.sort((a, b) => KIT_GROUP_IDS.indexOf(a.id) - KIT_GROUP_IDS.indexOf(b.id));
  return {
    code: result.code,
    report: buildJsonReport({
      check: CHECK_NAME,
      groups,
      exitCode: result.code,
      error: result.error,
    }),
    logs: result.logs,
    errors: result.errors,
  };
}

function selftest() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-perf-"));
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
    const logs = [];
    const code = run(root, {
      log(text) {
        logs.push(String(text));
      },
      error(text) {
        errors.push(String(text));
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
    "missing worker bundle cannot enforce",
    ({ root }) => {
      rmSync(join(root, "web/.svelte-kit/cloudflare/_worker.js"));
    },
    2,
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
  check(
    "empty worker inventory cannot enforce before any measurement",
    ({ root, budget }) => {
      budget.worker = {};
      save(root, budget);
    },
    2,
    "worker inventory is empty",
  );
  check(
    "omitted server section cannot enforce",
    ({ root, budget }) => {
      delete budget.server;
      save(root, budget);
    },
    2,
    "server",
  );
  check(
    "substituted worker entry cannot enforce",
    ({ root, budget }) => {
      budget.worker = { "assets/small.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
      save(root, budget);
    },
    2,
    "noncanonical worker entry",
  );
  check(
    "extra measurement section cannot enforce",
    ({ root, budget }) => {
      budget.extra = { js: { maxRawBytes: 10, maxGzipBytes: 10, maxFiles: 1 } };
      save(root, budget);
    },
    2,
    "unsupported budget section",
  );
  // Restore a valid tree: earlier negatives left an extra budget section and
  // an unbudgeted 100KB client chunk behind.
  rmSync(join(root, "web/.svelte-kit/output/client/_app/immutable/b.js"), { force: true });
  const fitWorker = readFileSync(join(root, "web/.svelte-kit/cloudflare/_worker.js"));
  const fitServer = readFileSync(join(root, "web/.svelte-kit/output/server/chunks/a.js"));
  const fitJs = readFileSync(join(root, "web/.svelte-kit/output/client/_app/immutable/a.js"));
  const fitCss = readFileSync(join(root, "web/.svelte-kit/output/client/_app/immutable/a.css"));
  const fitBudget = {
    worker: {
      "_worker.js": { maxRawBytes: fitWorker.length, maxGzipBytes: gzipSync(fitWorker).length },
    },
    server: {
      js: { maxRawBytes: fitServer.length, maxGzipBytes: gzipSync(fitServer).length, maxFiles: 4 },
    },
    client: {
      js: { maxRawBytes: fitJs.length, maxGzipBytes: gzipSync(fitJs).length, maxFiles: 4 },
      css: { maxRawBytes: fitCss.length, maxGzipBytes: gzipSync(fitCss).length, maxFiles: 4 },
    },
    startup: { maxMs: 30_000 },
  };
  save(root, fitBudget);
  const jsonFit = runJson(root);
  assert.equal(jsonFit.code, 0, `json fit must exit 0, got ${jsonFit.code}`);
  assert.equal(jsonFit.report.version, 1, "json report must carry version 1");
  assert.deepEqual(
    jsonFit.report.groups.map((group) => group.id),
    KIT_GROUP_IDS,
    "json report must carry the canonical groups",
  );
  cases += 1;
  console.log("PASS versioned json report carries the canonical inventory");
  save(root, { ...fitBudget, worker: {} });
  const jsonInvalid = runJson(root);
  assert.equal(jsonInvalid.code, 2, `json invalid plan must exit 2, got ${jsonInvalid.code}`);
  assert.equal(jsonInvalid.report.error?.code, "INVALID_PLAN", "invalid plan must use INVALID_PLAN");
  cases += 1;
  console.log("PASS versioned json report carries INVALID_PLAN for an invalid plan");
  console.log(`kit perf budget selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , ...args] = process.argv;
  const parsed = parseGateArgs(args);
  if (parsed.error) {
    console.error(`${gateUsage(SCRIPT_NAME)}: ${parsed.error}`);
    process.exitCode = 2;
  } else if (parsed.options.selftest) {
    process.exitCode = selftest();
  } else if (parsed.options.format === "json") {
    const measured = runJson(parsed.options.root ?? repoRoot);
    for (const line of measured.logs) console.error(line);
    for (const line of measured.errors) console.error(line);
    process.stdout.write(`${JSON.stringify(measured.report)}\n`);
    process.exitCode = measured.code;
  } else {
    process.exitCode = run(parsed.options.root ?? repoRoot);
  }
}
