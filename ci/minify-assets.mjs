// Build the served public assets from readable sources (minification follow-up):
// assets/islands/*.js and assets/styles.css are the reviewed sources;
// public/islands/*.js and public/styles.css are the deterministic esbuild
// --minify output that Workers serves. Top-level theme stylesheets
// (public/theme.css, public/*-theme.css) are authored in place with no
// assets/ source, so they are budgeted but never minified here. The budget
// ceilings in ci/budgets/bundle/ measure the minified bytes for built
// assets and the authored bytes for theme stylesheets, and every binder test
// executes them, so the suite itself proves the minified output equivalent.
// Regenerate with `npm run build:assets`; CI fails on drift (`--check`).
// 0 = built/verified, 1 = drift or minify failure.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { loadBundleBudgets } from "./budget-fragments.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = join(repoRoot, "node_modules", ".bin", "esbuild");

// Theme stylesheets are authored in public/ with no assets/ source, so they
// are skipped here and a new authored file must extend this list explicitly;
// anything else budgeted without a source fails closed in minifyBytes instead
// of silently escaping the drift check (still enforced by
// check-bundle-budget.mjs either way).
const AUTHORED_CSS = new Set([
  "public/theme.css",
  "public/event-theme.css",
  "public/profile-theme.css",
  "public/schedule-theme.css",
  "public/theme-tokens.css",
]);
// Budget entries are read from the checked root (not captured at import),
// so --selftest can copy the budget fragments into a scratch root and prove
// that check() fails closed on scratch mutations. On the real tree this
// aggregates the same ci/budgets/bundle/ fragments, so behavior there is
// unchanged.
function budgetPathsFor(root) {
  const budgets = loadBundleBudgets(root);
  return Object.keys(budgets)
    .filter((entry) => !AUTHORED_CSS.has(entry))
    .sort();
}

function sourceFor(entry) {
  // public/islands/<name>.js -> assets/islands/<name>.js; public/styles.css -> assets/styles.css.
  return entry.replace(/^public\//, "assets/");
}

function minifyBytes(entry, root) {
  const source = join(root, sourceFor(entry));
  if (!existsSync(source)) {
    throw new Error(
      `no source ${sourceFor(entry)} for ${entry}: add to AUTHORED_CSS in ci/minify-assets.mjs or create ${sourceFor(entry)}`,
    );
  }
  // esbuild infers the loader from the file extension, so keep the real
  // filename on the command line (never a temp copy or stdin without an
  // explicit --loader): a probe that minified member-profile.js without its
  // .js extension silently dropped the "use strict" prefix.
  const args = entry.endsWith(".css")
    ? ["--loader:.css=css", "--minify", source]
    : ["public/islands/event-device-timezone.js", "public/islands/member-profile.js"].includes(
          entry,
        )
      ? ["--bundle", "--format=iife", "--minify", source]
      : ["--minify", source];
  return execFileSync(esbuild, args, { maxBuffer: 16 * 1024 * 1024 });
}

// Every minified script must still parse; node --check on a sibling .mjs
// probe is the cheapest equivalence tripwire before the binder suite
// executes the bytes. (Stdin probes cannot work: --check re-opens its input
// path, so a pipe is ENOENT; .mjs keeps `export` valid.)
function parsesAsJs(bytes, entry) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "minify-parse-"));
  try {
    const probe = join(dir, "probe.mjs");
    writeFileSync(probe, bytes);
    const checked = spawnSync(process.execPath, ["--check", probe]);
    if (checked.status !== 0) {
      return `node --check failed: ${checked.stderr.toString().slice(0, 200)}`;
    }
    void entry;
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function build(root = repoRoot, output = console) {
  let entries;
  try {
    entries = budgetPathsFor(root);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    output.error(`minify assets: cannot read budget: ${detail}`);
    return 1;
  }
  let built = 0;
  for (const entry of entries) {
    let bytes;
    try {
      bytes = minifyBytes(entry, root);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const prefix = detail.startsWith("no source") ? "" : "esbuild failed: ";
      output.error(`minify assets: ${entry}: ${prefix}${detail}`);
      return 1;
    }
    if (!entry.endsWith(".css")) {
      const problem = parsesAsJs(bytes, entry);
      if (problem) {
        output.error(`minify assets: ${entry}: ${problem}`);
        return 1;
      }
    }
    writeFileSync(join(root, entry), bytes);
    output.log(`minified ${entry}: ${bytes.length}B`);
    built += 1;
  }
  output.log(`minify assets: ${built} files built.`);
  return 0;
}

// Fail closed on drift: regenerate every byte and compare against the
// checked-in public/ output, so an edited source without a regenerated (and
// reviewed) public/ file cannot merge or deploy.
export function check(root = repoRoot, output = console) {
  let entries;
  try {
    entries = budgetPathsFor(root);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    output.error(`minify assets: cannot read budget: ${detail}`);
    return 1;
  }
  let drifted = 0;
  for (const entry of entries) {
    let bytes;
    try {
      bytes = minifyBytes(entry, root);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const prefix = detail.startsWith("no source") ? "" : "esbuild failed: ";
      output.error(`minify assets: ${entry}: ${prefix}${detail}`);
      return 1;
    }
    let checked;
    try {
      checked = readFileSync(join(root, entry));
    } catch (error) {
      output.error(`minify assets: ${entry}: missing checked-in output: ${error.message}`);
      return 1;
    }
    if (!bytes.equals(checked)) {
      output.error(
        `minify assets: ${entry}: drifted (${checked.length}B checked in, ` +
          `${bytes.length}B regenerated); run npm run build:assets and commit the output`,
      );
      drifted += 1;
    } else {
      output.log(`ok ${entry}: ${bytes.length}B in sync`);
    }
  }
  if (drifted) return 1;
  output.log("minify assets: every built file matches its source.");
  return 0;
}

function selftest() {
  let cases = 0;
  assert.equal(typeof build, "function");
  assert.equal(typeof check, "function");
  assert.ok(
    parsesAsJs(Buffer.from("export const ok = 1;\n"), "probe.js") === null,
    "valid JS parses",
  );
  assert.ok(
    typeof parsesAsJs(Buffer.from("export const = ;\n"), "probe.js") === "string",
    "broken JS fails node --check",
  );
  cases += 2;
  console.log("PASS valid JS parses");
  console.log("PASS broken JS fails node --check");

  // Prove every failure branch of check() on a scratch copy of the real
  // tree: check() reads its budget list from the given root, so mutating the
  // scratch budget/sources/outputs exercises the same code that guards the
  // real tree, without ever writing to it. The scratch root is removed in a
  // finally, so it is cleaned up on success and on assertion failure alike.
  const witnessEntry = "public/islands/avatar.js";
  const witnessSource = sourceFor(witnessEntry);
  const realOutputBefore = readFileSync(join(repoRoot, witnessEntry));
  const realSourceBefore = readFileSync(join(repoRoot, witnessSource));
  const witnessBudgetPath = join("ci", "budgets", "bundle", "avatar.js.json");
  const realBudgetBefore = readFileSync(join(repoRoot, witnessBudgetPath), "utf8");
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "minify-assets-"),
  );
  try {
    cpSync(join(repoRoot, "assets"), join(scratch, "assets"), { recursive: true });
    cpSync(join(repoRoot, "public"), join(scratch, "public"), { recursive: true });
    mkdirSync(join(scratch, "ci", "budgets"), { recursive: true });
    cpSync(join(repoRoot, "ci", "budgets", "bundle"), join(scratch, "ci", "budgets", "bundle"), {
      recursive: true,
    });
    // esbuild resolves the nearest tsconfig.json from each source file, and
    // the repo tsconfig changes the minified bytes (the "use strict" prefix):
    // without this copy an unmodified scratch tree drifts by 13B per island.
    copyFileSync(join(repoRoot, "tsconfig.json"), join(scratch, "tsconfig.json"));

    const runCheck = () => {
      const errors = [];
      const code = check(scratch, {
        log() {},
        error(text) {
          errors.push(String(text));
        },
      });
      return { code, errors };
    };
    const runBuild = () => {
      const errors = [];
      const code = build(scratch, {
        log() {},
        error(text) {
          errors.push(String(text));
        },
      });
      return { code, errors };
    };

    {
      const { code, errors } = runCheck();
      assert.equal(code, 0, `unmodified scratch copy should pass: ${errors.join("; ")}`);
      cases += 1;
      console.log("PASS unmodified scratch copy is in sync");
    }

    // Prove drift and missing-output for every budgeted entry, not just one
    // witness: a filter or early-exit bug that skips an entry would otherwise
    // stay green while appearing covered.
    const entries = budgetPathsFor(scratch);
    for (const entry of entries) {
      const sourcePath = join(scratch, sourceFor(entry));
      const original = readFileSync(sourcePath);
      // esbuild strips comments when minifying, so the probe must be real
      // code (or a real CSS rule) that survives --minify and changes the
      // regenerated bytes.
      const probe = entry.endsWith(".css")
        ? Buffer.from("\n.minify-selftest-drift{color:#123456}\n")
        : Buffer.from("\n;globalThis.__minifySelftestDrift = 1;\n");
      try {
        writeFileSync(sourcePath, Buffer.concat([original, probe]));
        const { code, errors } = runCheck();
        assert.equal(code, 1, `changed source should fail for ${entry}: ${errors.join("; ")}`);
        assert.ok(
          errors.some((text) => text.includes(entry) && text.includes("drifted")),
          `changed source should report drift of ${entry}: ${errors.join("; ")}`,
        );
      } finally {
        writeFileSync(sourcePath, original);
      }
      cases += 1;
      console.log(`PASS changed source fails with drift diagnostic for ${entry}`);
    }

    for (const entry of entries) {
      const outputPath = join(scratch, entry);
      const original = readFileSync(outputPath);
      try {
        rmSync(outputPath);
        const { code, errors } = runCheck();
        assert.equal(code, 1, `deleted output should fail for ${entry}: ${errors.join("; ")}`);
        assert.ok(
          errors.some((text) => text.includes(entry) && text.includes("missing checked-in output")),
          `deleted output should report missing output for ${entry}: ${errors.join("; ")}`,
        );
      } finally {
        writeFileSync(outputPath, original);
      }
      cases += 1;
      console.log(`PASS deleted output fails with missing-output diagnostic for ${entry}`);
    }

    {
      const budgetPath = join(scratch, witnessBudgetPath);
      const originalText = readFileSync(budgetPath, "utf8");
      try {
        writeFileSync(budgetPath, "{");
        const checked = runCheck();
        assert.equal(
          checked.code,
          1,
          `corrupt budget should fail check: ${checked.errors.join("; ")}`,
        );
        assert.ok(
          checked.errors.some((text) => text.includes("cannot read budget")),
          `corrupt budget should report cannot read budget in check: ${checked.errors.join("; ")}`,
        );
        const built = runBuild();
        assert.equal(built.code, 1, `corrupt budget should fail build: ${built.errors.join("; ")}`);
        assert.ok(
          built.errors.some((text) => text.includes("cannot read budget")),
          `corrupt budget should report cannot read budget in build: ${built.errors.join("; ")}`,
        );
      } finally {
        writeFileSync(budgetPath, originalText);
      }
      cases += 1;
      console.log("PASS corrupt budget fails closed in check and build");
    }

    {
      const probeEntry = "public/islands/missing-source-probe.js";
      const probePath = join(scratch, "ci", "budgets", "bundle", "missing-source-probe.js.json");
      try {
        writeFileSync(
          probePath,
          JSON.stringify({ budgets: { [probeEntry]: { maxRawBytes: 1, maxGzipBytes: 1 } } }),
        );
        const { code, errors } = runCheck();
        assert.equal(code, 1, `budget entry without a source should fail: ${errors.join("; ")}`);
        assert.ok(
          errors.some((text) => text.includes(probeEntry) && text.includes("no source")),
          `budget entry without a source should report no source for ${probeEntry}: ${errors.join("; ")}`,
        );
      } finally {
        rmSync(probePath, { force: true });
      }
      cases += 1;
      console.log("PASS budget entry without a source fails with no-source diagnostic");
    }

    assert.ok(
      realOutputBefore.equals(readFileSync(join(repoRoot, witnessEntry))),
      "selftest must never write the real public/ tree",
    );
    assert.ok(
      realSourceBefore.equals(readFileSync(join(repoRoot, witnessSource))),
      "selftest must never write the real assets/ tree",
    );
    assert.equal(
      readFileSync(join(repoRoot, witnessBudgetPath), "utf8"),
      realBudgetBefore,
      "selftest must never write the real budget fragments",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.ok(!existsSync(scratch), "scratch root is removed");
  console.log("PASS scratch root is removed and the real tree is untouched");
  cases += 1;
  console.log(`minify assets selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (process.argv.length === 3 && arg === "--check") {
    process.exitCode = check();
  } else if (process.argv.length === 3 && arg === "--selftest") {
    process.exitCode = selftest();
  } else if (process.argv.length === 2) {
    process.exitCode = build();
  } else {
    console.error("Usage: node ci/minify-assets.mjs [--check|--selftest]");
    process.exitCode = 2;
  }
}
