// Canonical artifact-inventory authority for the bundle gates.
//
// This module is the one repo authority for WHICH artifacts the bundle gates
// must measure. Numeric ceilings stay configurable in the budget JSON files;
// identity (which files and groups exist) is fixed here and validated before
// any artifact is read. An inventory mismatch is an invalid plan (exit 2),
// never a silent drop and never a fits verdict.
//
// Canonical inventory:
//   Hono dry-run Worker: dist/worker.js            (ci/check-worker-bundle.mjs)
//   Kit _worker.js:      web/.svelte-kit/cloudflare/_worker.js
//   Kit server JS:       web/.svelte-kit/output/server (**/*.js, no sourcemaps)
//   Kit client JS/CSS:   web/.svelte-kit/output/client/_app (**/*.js, **/*.css)
//   (ci/check-kit-perf.mjs)
//
// Shared CLI surface for both gates: --root <dir>, --format json,
// --selftest, --dry-run. --dry-run is the same read-only measurement, not
// build/apply authority. Unknown or malformed flags exit 2 before any
// subprocess or file write.
export const JSON_VERSION = 1;

export const KIT_WORKER_ENTRY = "_worker.js";
export const KIT_WORKER_PATH = "web/.svelte-kit/cloudflare/_worker.js";
export const KIT_SERVER_DIR = "web/.svelte-kit/output/server";
export const KIT_CLIENT_DIR = "web/.svelte-kit/output/client/_app";

// The only top-level sections a Kit budget plan may define (besides $
// metadata). Shared by validateKitPlan below and the fragment loader
// (ci/budget-fragments.mjs), which must reject unknown sections before
// aggregation can drop them on the floor.
export const KIT_BUDGET_SECTIONS = ["worker", "server", "client", "startup"];

export const KIT_GROUP_IDS = ["kit.worker", "kit.server.js", "kit.client.js", "kit.client.css"];
export const KIT_CHECK_IDS = [
  "kit.worker._worker.js",
  "kit.server.js",
  "kit.client.js",
  "kit.client.css",
];

export const WORKER_BUNDLE_ENTRY = "dist/worker.js";
export const WORKER_GROUP_IDS = ["worker.bundle"];
export const WORKER_CHECK_IDS = ["worker.bundle.dist/worker.js"];

export const ERROR_CODES = [
  "INVALID_PLAN",
  "MISSING_EVIDENCE",
  "INCOMPLETE_ENUMERATION",
  "INVALID_FLAGS",
];

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isMetadataKey(key) {
  return key.startsWith("$");
}

// Keep echoed plan keys bounded so diagnostics stay under the 500-char line
// budget no matter what a malformed budget contains.
function shortKey(key) {
  return key.length > 100 ? `${key.slice(0, 97)}…` : key;
}

function checkCeilingShape(ceiling) {
  return (
    isObject(ceiling) &&
    Number.isSafeInteger(ceiling.maxRawBytes) &&
    ceiling.maxRawBytes > 0 &&
    Number.isSafeInteger(ceiling.maxGzipBytes) &&
    ceiling.maxGzipBytes > 0
  );
}

function checkGroupShape(group) {
  return (
    isObject(group) &&
    checkCeilingShape(group) &&
    Number.isSafeInteger(group.maxFiles) &&
    group.maxFiles > 0
  );
}

// Validate a Kit budget plan against the canonical inventory. Returns null
// when the plan is valid, otherwise a short human reason naming the problem.
// Pure: reads nothing, writes nothing.
export function validateKitPlan(budget) {
  if (!isObject(budget)) return "budget must be an object";
  for (const key of Object.keys(budget)) {
    if (!KIT_BUDGET_SECTIONS.includes(key) && !isMetadataKey(key)) {
      return `unsupported budget section: ${shortKey(key)}`;
    }
  }
  if (!isObject(budget.worker)) return "budget must have a worker object";
  const workerEntries = Object.keys(budget.worker);
  if (workerEntries.length === 0)
    return "worker inventory is empty: budget must measure _worker.js";
  for (const entry of workerEntries) {
    if (entry !== KIT_WORKER_ENTRY) {
      return `noncanonical worker entry: ${shortKey(entry)} (canonical inventory is exactly _worker.js)`;
    }
    if (!checkCeilingShape(budget.worker[entry])) {
      return `invalid worker entry or ceilings: ${shortKey(entry)}`;
    }
  }
  if (!isObject(budget.server)) return "budget must have a server object";
  const serverKeys = Object.keys(budget.server);
  if (serverKeys.length !== 1 || serverKeys[0] !== "js" || !checkGroupShape(budget.server.js)) {
    return "invalid server.js budget (needs maxRawBytes, maxGzipBytes, maxFiles)";
  }
  if (!isObject(budget.client)) return "budget must have a client object";
  const clientKeys = Object.keys(budget.client);
  if (clientKeys.length !== 2 || !clientKeys.includes("js") || !clientKeys.includes("css")) {
    return "client inventory must be exactly js and css groups";
  }
  for (const key of ["js", "css"]) {
    if (!checkGroupShape(budget.client[key])) {
      return `invalid client.${key} budget (needs maxRawBytes, maxGzipBytes, maxFiles)`;
    }
  }
  if (!Number.isSafeInteger(budget.startup?.maxMs) || budget.startup.maxMs <= 0) {
    return "startup.maxMs must be a positive integer";
  }
  return null;
}

// Validate a Worker budget plan against the canonical inventory. Returns null
// when valid, otherwise a short human reason. Pure: reads nothing.
export function validateWorkerPlan(doc) {
  if (!isObject(doc)) return "budget must be an object";
  for (const key of Object.keys(doc)) {
    if (key !== "budgets" && !isMetadataKey(key)) {
      return `unsupported budget section: ${shortKey(key)}`;
    }
  }
  const budgets = doc.budgets;
  if (!isObject(budgets)) return "budgets must be a nonempty object";
  const entries = Object.keys(budgets);
  if (entries.length === 0) return "budgets must be a nonempty object";
  for (const entry of entries) {
    if (entry !== WORKER_BUNDLE_ENTRY) {
      return (
        `noncanonical bundle entry: ${shortKey(entry)} ` +
        `(canonical inventory is exactly ${WORKER_BUNDLE_ENTRY})`
      );
    }
    const ceiling = budgets[entry];
    if (!checkCeilingShape(ceiling)) {
      return `invalid entry or raw/gzip ceilings: ${shortKey(entry)}`;
    }
  }
  return null;
}

// Parse the shared gate CLI. Returns { options } or { error } where error is
// a short human reason. Pure: no subprocess, no file access.
export function parseGateArgs(args) {
  const options = { root: null, format: "human", selftest: false, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const inlineRoot = arg.startsWith("--root=") ? arg.slice("--root=".length) : null;
    if (arg === "--selftest") {
      options.selftest = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--root" || inlineRoot !== null) {
      const value = inlineRoot ?? args[i + 1];
      if (value === undefined || value === "" || (inlineRoot === null && value.startsWith("--"))) {
        return { error: "--root needs a directory" };
      }
      options.root = value;
      if (inlineRoot === null) i += 1;
    } else if (arg === "--format") {
      const value = args[i + 1];
      if (value === undefined) return { error: "--format needs a value (supported: json)" };
      if (value !== "json")
        return { error: `unsupported --format value: ${shortKey(value)} (supported: json)` };
      options.format = "json";
      i += 1;
    } else if (arg === "--") {
      return { error: `unknown flag: ${shortKey(arg)}` };
    } else {
      return { error: `unknown flag: ${shortKey(arg)}` };
    }
  }
  if (options.selftest && (options.root !== null || options.format !== "human" || options.dryRun)) {
    return { error: "--selftest takes no other flags" };
  }
  return { options };
}

export function gateUsage(scriptName) {
  return `Usage: node ${scriptName} [--root <dir>|--root=<dir>] [--format json] [--dry-run] [--selftest]`;
}

// Build the versioned JSON report. Groups always carry the canonical IDs;
// measured checks carry rawBytes/gzipBytes; exit 2 carries a fixed error code
// and a concrete next_action. Deterministic: no timestamps, stable key order.
export function buildJsonReport({ check, groups, exitCode, error = null }) {
  const report = {
    version: JSON_VERSION,
    check,
    ok: exitCode === 0,
    exitCode,
    groups: groups.map((group) => ({
      id: group.id,
      status: group.status,
      checks: group.checks.map((entry) => {
        const out = { id: entry.id, status: entry.status };
        if (typeof entry.rawBytes === "number") out.rawBytes = entry.rawBytes;
        if (typeof entry.gzipBytes === "number") out.gzipBytes = entry.gzipBytes;
        if (typeof entry.files === "number") out.files = entry.files;
        if (typeof entry.maxRawBytes === "number") out.maxRawBytes = entry.maxRawBytes;
        if (typeof entry.maxGzipBytes === "number") out.maxGzipBytes = entry.maxGzipBytes;
        if (typeof entry.maxFiles === "number") out.maxFiles = entry.maxFiles;
        return out;
      }),
    })),
  };
  if (error) {
    report.error = {
      code: error.code,
      message: error.message,
      next_action: error.nextAction,
    };
  }
  return report;
}

export function cannotEnforceGroups(groupIds, checkIds) {
  let index = 0;
  return groupIds.map((id) => {
    const checkId = checkIds[index];
    index += 1;
    return { id, status: "cannot-enforce", checks: [{ id: checkId, status: "cannot-enforce" }] };
  });
}
