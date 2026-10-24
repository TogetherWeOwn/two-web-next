// Main app Worker bundle ceiling: gates the wrangler dry-run output for the
// Hono Worker (src/worker.ts via wrangler.jsonc), mirroring
// ci/check-bundle-budget.mjs enforcement semantics.
// Exit 0 fits, 1 breach, 2 cannot enforce.
//
// The dry-run step (`npx wrangler deploy --dry-run --outdir dist`) writes
// dist/worker.js; this checker measures those bytes (raw + default-level
// gzip, identical to the served-asset checker) against
// ci/worker-bundle-budget.json. Served-asset and Kit budgets are untouched;
// no deploy behavior changes. A breach fails with a remediation pointer, not
// a silent size line.
//
// The canonical required measurement inventory (exactly dist/worker.js) lives
// in ci/bundle-inventory.mjs and is validated before the bundle is read: a
// substituted, misspelled or extended plan is an invalid plan (exit 2),
// never a silent drop and never a fits verdict.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import {
  WORKER_BUNDLE_ENTRY,
  WORKER_CHECK_IDS,
  WORKER_GROUP_IDS,
  buildJsonReport,
  cannotEnforceGroups,
  gateUsage,
  parseGateArgs,
  validateWorkerPlan,
} from "./bundle-inventory.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_NAME = "ci/check-worker-bundle.mjs";
const CHECK_NAME = "worker-bundle";

const REMEDIATION =
  "see ci/worker-bundle-budget.json ($comment) for the measured baseline and the x1.25 rule; " +
  "raising a ceiling needs an explicit decision explaining the growth, never a relaxation to make CI green. " +
  "Re-measure with: npx wrangler deploy --dry-run --outdir dist && node ci/check-worker-bundle.mjs";

const INVALID_PLAN_NEXT_ACTION =
  "Fix ci/worker-bundle-budget.json so budgets contains exactly dist/worker.js " +
  "with raw/gzip ceilings (canonical inventory in ci/bundle-inventory.mjs), " +
  "then rerun node ci/check-worker-bundle.mjs";
const REBUILD_NEXT_ACTION =
  "Run npx wrangler deploy --dry-run --outdir dist, then rerun node ci/check-worker-bundle.mjs";

function boundLine(line) {
  return line.length > 500 ? `${line.slice(0, 497)}…` : line;
}

// Measure the canonical bundle at root without printing. Returns the exit
// code, the bounded human lines, the canonical group, and the fixed error
// object for exit 2. The plan is validated before the bundle is read.
export function measure(root = repoRoot) {
  const logs = [];
  const errors = [];
  const groups = [];
  const fail = (code, error) => ({ code, logs, errors, groups, error });

  let doc;
  try {
    doc = JSON.parse(readFileSync(join(root, "ci/worker-bundle-budget.json"), "utf8"));
  } catch (error) {
    errors.push(
      boundLine(`worker bundle budget: cannot enforce: ${error.message}. ${REMEDIATION}`),
    );
    return fail(2, {
      code: "INVALID_PLAN",
      message: boundLine(`cannot enforce: ${error.message}`),
      nextAction: INVALID_PLAN_NEXT_ACTION,
    });
  }
  const planProblem = validateWorkerPlan(doc);
  if (planProblem) {
    errors.push(boundLine(`worker bundle budget: cannot enforce: ${planProblem}. ${REMEDIATION}`));
    return fail(2, {
      code: "INVALID_PLAN",
      message: boundLine(`invalid plan: ${planProblem}`),
      nextAction: INVALID_PLAN_NEXT_ACTION,
    });
  }

  const ceiling = doc.budgets[WORKER_BUNDLE_ENTRY];
  let bytes;
  try {
    bytes = readFileSync(join(root, WORKER_BUNDLE_ENTRY));
  } catch (error) {
    // The dry-run step must run first; a missing bundle proves nothing.
    errors.push(
      boundLine(
        `worker bundle budget: cannot enforce: ${WORKER_BUNDLE_ENTRY}: missing/unreadable bundle: ${error.message} ` +
          `(run npx wrangler deploy --dry-run --outdir dist first). ${REMEDIATION}`,
      ),
    );
    return fail(2, {
      code: "MISSING_EVIDENCE",
      message: boundLine(`${WORKER_BUNDLE_ENTRY}: missing/unreadable bundle: ${error.message}`),
      nextAction: REBUILD_NEXT_ACTION,
    });
  }
  const raw = bytes.length;
  // Default zlib level, identical to the served-asset checker, not best-case gzip.
  const gzip = gzipSync(bytes).length;
  const exceeded = [];
  if (raw > ceiling.maxRawBytes) exceeded.push(`raw ${raw}B over ${ceiling.maxRawBytes}B`);
  if (gzip > ceiling.maxGzipBytes) exceeded.push(`gzip ${gzip}B over ${ceiling.maxGzipBytes}B`);
  if (exceeded.length) {
    errors.push(
      boundLine(
        `worker bundle budget: ${WORKER_BUNDLE_ENTRY}: ${exceeded.join(", ")}. ${REMEDIATION}`,
      ),
    );
    groups.push({
      id: "worker.bundle",
      status: "fail",
      checks: [
        {
          id: "worker.bundle.dist/worker.js",
          status: "fail",
          rawBytes: raw,
          gzipBytes: gzip,
          maxRawBytes: ceiling.maxRawBytes,
          maxGzipBytes: ceiling.maxGzipBytes,
        },
      ],
    });
    return fail(1, null);
  }
  logs.push(
    boundLine(
      `ok ${WORKER_BUNDLE_ENTRY}: raw ${raw}/${ceiling.maxRawBytes}B, gzip ${gzip}/${ceiling.maxGzipBytes}B`,
    ),
  );
  groups.push({
    id: "worker.bundle",
    status: "pass",
    checks: [
      {
        id: "worker.bundle.dist/worker.js",
        status: "pass",
        rawBytes: raw,
        gzipBytes: gzip,
        maxRawBytes: ceiling.maxRawBytes,
        maxGzipBytes: ceiling.maxGzipBytes,
      },
    ],
  });
  logs.push("worker bundle budget: main Worker bundle fits.");
  return fail(0, null);
}

export function run(root = repoRoot, output = console) {
  const result = measure(root);
  for (const line of result.logs) output.log(line);
  for (const line of result.errors) output.error(line);
  return result.code;
}

// Versioned JSON measurement for agents: the canonical group with its stable
// ID, measured bytes when measured, and a fixed error code plus a concrete
// next_action on exit 2. Human lines stay available for stderr.
export function runJson(root = repoRoot) {
  const result = measure(root);
  const groups =
    result.groups.length > 0
      ? result.groups
      : cannotEnforceGroups(WORKER_GROUP_IDS, WORKER_CHECK_IDS);
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
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "worker-bundle-"),
  );
  try {
    mkdirSync(join(root, "ci"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    const payload = Buffer.from(
      Array.from({ length: 128 }, (_, i) => `/* worker-${i} */\n`).join(""),
    );
    const exact = { maxRawBytes: payload.length, maxGzipBytes: gzipSync(payload).length };
    let cases = 0;
    const check = (name, mutate, expected, message) => {
      const budget = { budgets: { "dist/worker.js": { ...exact } } };
      writeFileSync(join(root, "dist/worker.js"), payload);
      writeFileSync(join(root, "ci/worker-bundle-budget.json"), JSON.stringify(budget));
      mutate(budget);
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
    const save = (budget) =>
      writeFileSync(join(root, "ci/worker-bundle-budget.json"), JSON.stringify(budget));
    check("exact raw and gzip ceilings fit", () => {}, 0);
    check(
      "lowered raw ceiling fails the gate",
      (budget) => {
        budget.budgets["dist/worker.js"].maxRawBytes -= 1;
        save(budget);
      },
      1,
      "dist/worker.js: raw",
    );
    check(
      "lowered gzip ceiling fails the gate",
      (budget) => {
        budget.budgets["dist/worker.js"].maxGzipBytes -= 1;
        save(budget);
      },
      1,
      "dist/worker.js: gzip",
    );
    check(
      "breach names the remediation pointer",
      (budget) => {
        budget.budgets["dist/worker.js"].maxRawBytes -= 1;
        save(budget);
      },
      1,
      "ci/worker-bundle-budget.json",
    );
    check(
      "missing bundle cannot enforce",
      () => rmSync(join(root, "dist/worker.js")),
      2,
      "cannot enforce",
    );
    check(
      "missing budget cannot enforce",
      () => rmSync(join(root, "ci/worker-bundle-budget.json")),
      2,
      "cannot enforce",
    );
    check(
      "malformed JSON cannot enforce",
      () => writeFileSync(join(root, "ci/worker-bundle-budget.json"), "{"),
      2,
      "cannot enforce",
    );
    for (const invalid of [
      {},
      { budgets: {} },
      { budgets: [] },
      { budgets: { "../escape.js": exact } },
      { budgets: { "dist/worker.js": { maxRawBytes: 1 } } },
      { budgets: { "dist/worker.js": { maxRawBytes: -1, maxGzipBytes: "100" } } },
    ]) {
      check("invalid budget fails closed", () => save(invalid), 2, "cannot enforce");
    }
    check(
      "substituted bundle entry cannot enforce",
      (budget) => {
        budget.budgets = { "dist/small.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
        save(budget);
      },
      2,
      "noncanonical bundle entry",
    );
    check(
      "typo bundle entry cannot enforce",
      (budget) => {
        budget.budgets = { "dist/worker.jsx": { maxRawBytes: 4096, maxGzipBytes: 4096 } };
        save(budget);
      },
      2,
      "noncanonical bundle entry",
    );
    check(
      "extra bundle entry cannot enforce",
      (budget) => {
        budget.budgets["dist/extra.js"] = { maxRawBytes: 4096, maxGzipBytes: 4096 };
        save(budget);
      },
      2,
      "noncanonical bundle entry",
    );
    save({ budgets: { "dist/worker.js": { ...exact } } });
    writeFileSync(join(root, "dist/worker.js"), payload);
    const jsonFit = runJson(root);
    assert.equal(jsonFit.code, 0, `json fit must exit 0, got ${jsonFit.code}`);
    assert.equal(jsonFit.report.version, 1, "json report must carry version 1");
    assert.deepEqual(
      jsonFit.report.groups.map((group) => group.id),
      WORKER_GROUP_IDS,
      "json report must carry the canonical group",
    );
    cases += 1;
    console.log("PASS versioned json report carries the canonical inventory");
    save({ budgets: { "dist/other.js": { maxRawBytes: 4096, maxGzipBytes: 4096 } } });
    const jsonInvalid = runJson(root);
    assert.equal(jsonInvalid.code, 2, `json invalid plan must exit 2, got ${jsonInvalid.code}`);
    assert.equal(
      jsonInvalid.report.error?.code,
      "INVALID_PLAN",
      "invalid plan must use INVALID_PLAN",
    );
    cases += 1;
    console.log("PASS versioned json report carries INVALID_PLAN for an invalid plan");
    console.log(`worker bundle budget selftest: ${cases} cases passed.`);
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
