// Build the served public assets from readable sources (minification follow-up):
// assets/islands/*.js and assets/styles.css are the reviewed sources;
// public/islands/*.js and public/styles.css are the deterministic esbuild
// --minify output that Workers serves. The budget ceilings in
// ci/bundle-budget.json measure the minified bytes, and every binder test
// executes them, so the suite itself proves the minified output equivalent.
// Regenerate with `npm run build:assets`; CI fails on drift (`--check`).
// 0 = built/verified, 1 = drift or minify failure.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = join(repoRoot, "node_modules", ".bin", "esbuild");

const BUDGET_PATHS = Object.keys(
  JSON.parse(readFileSync(join(repoRoot, "ci", "bundle-budget.json"), "utf8")).budgets,
).sort();

function sourceFor(entry) {
  // public/islands/<name>.js -> assets/islands/<name>.js; public/styles.css -> assets/styles.css.
  return entry.replace(/^public\//, "assets/");
}

function minifyBytes(entry, root) {
  const source = join(root, sourceFor(entry));
  // esbuild infers the loader from the file extension, so keep the real
  // filename on the command line (never a temp copy or stdin without an
  // explicit --loader): a probe that minified member-profile.js without its
  // .js extension silently dropped the "use strict" prefix.
  const args = entry.endsWith(".css")
    ? ["--loader:.css=css", "--minify", source]
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
  let built = 0;
  for (const entry of BUDGET_PATHS) {
    let bytes;
    try {
      bytes = minifyBytes(entry, root);
    } catch (error) {
      output.error(`minify assets: ${entry}: esbuild failed: ${error.message}`);
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
  let drifted = 0;
  for (const entry of BUDGET_PATHS) {
    let bytes;
    try {
      bytes = minifyBytes(entry, root);
    } catch (error) {
      output.error(`minify assets: ${entry}: esbuild failed: ${error.message}`);
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
  // Real coverage comes from --check over the repo tree; the unit cases
  // below pin the CLI contract and the parse tripwire.
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
