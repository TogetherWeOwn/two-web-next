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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REMEDIATION =
  "see ci/worker-bundle-budget.json ($comment) for the measured baseline and the x1.25 rule; " +
  "raising a ceiling needs an explicit decision explaining the growth, never a relaxation to make CI green. " +
  "Re-measure with: npx wrangler deploy --dry-run --outdir dist && node ci/check-worker-bundle.mjs";

export function run(root = repoRoot, output = console) {
  let budgets;
  try {
    budgets = JSON.parse(readFileSync(join(root, "ci/worker-bundle-budget.json"), "utf8")).budgets;
    if (
      !budgets ||
      typeof budgets !== "object" ||
      Array.isArray(budgets) ||
      !Object.keys(budgets).length
    ) {
      throw new Error("budgets must be a nonempty object");
    }
    for (const [entry, ceiling] of Object.entries(budgets)) {
      if (
        entry.includes("..") ||
        !ceiling ||
        !Number.isSafeInteger(ceiling.maxRawBytes) ||
        ceiling.maxRawBytes <= 0 ||
        !Number.isSafeInteger(ceiling.maxGzipBytes) ||
        ceiling.maxGzipBytes <= 0
      ) {
        throw new Error(`invalid entry or raw/gzip ceilings: ${entry}`);
      }
    }
  } catch (error) {
    output.error(`worker bundle budget: cannot enforce: ${error.message}. ${REMEDIATION}`);
    return 2;
  }

  let breaches = 0;
  for (const [entry, ceiling] of Object.entries(budgets)) {
    let bytes;
    try {
      bytes = readFileSync(join(root, entry));
    } catch (error) {
      // The dry-run step must run first; a missing bundle proves nothing.
      output.error(
        `worker bundle budget: cannot enforce: ${entry}: missing/unreadable bundle: ${error.message} ` +
          `(run npx wrangler deploy --dry-run --outdir dist first). ${REMEDIATION}`,
      );
      return 2;
    }
    const raw = bytes.length;
    // Default zlib level, identical to the served-asset checker, not best-case gzip.
    const gzip = gzipSync(bytes).length;
    const exceeded = [];
    if (raw > ceiling.maxRawBytes) exceeded.push(`raw ${raw}B over ${ceiling.maxRawBytes}B`);
    if (gzip > ceiling.maxGzipBytes) exceeded.push(`gzip ${gzip}B over ${ceiling.maxGzipBytes}B`);
    if (exceeded.length) {
      output.error(`worker bundle budget: ${entry}: ${exceeded.join(", ")}. ${REMEDIATION}`);
      breaches += 1;
    } else {
      output.log(
        `ok ${entry}: raw ${raw}/${ceiling.maxRawBytes}B, gzip ${gzip}/${ceiling.maxGzipBytes}B`,
      );
    }
  }
  if (breaches) return 1;
  output.log("worker bundle budget: main Worker bundle fits.");
  return 0;
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
    console.log(`worker bundle budget selftest: ${cases} cases passed.`);
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--selftest")) {
    console.error("Usage: node ci/check-worker-bundle.mjs [--selftest]");
    process.exitCode = 2;
  } else {
    process.exitCode = process.argv[2] === "--selftest" ? selftest() : run(repoRoot);
  }
}
