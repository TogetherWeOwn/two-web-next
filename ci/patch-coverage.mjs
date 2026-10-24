// Changed-lines coverage gate (WARN, 80%): every added TypeScript line should
// be executed by the suite. Aggregate floors in vitest.config.ts stay; this
// gate stops a well-covered patch from hiding behind them.
//
// Inputs: `git diff -U0 <base>...HEAD` for added lines, and the v8
// `coverage/coverage-final.json` report (the `json` reporter in
// vitest.config.ts) for per-line hits. An added statement line counts as
// covered when any statement starting on it ran. Changed files absent from
// the report count as fully uncovered. Non-statement lines (blanks, braces)
// and non-TS lines are out of scope.
//
// Modes: default WARN prints ::warning:: and exits 0 (new checks start
// WARN). --strict exits 1 under 80% (a future HARD flip). --base <ref>
// overrides the diff base (default origin/main). --selftest runs fixtures.
// --json emits schema v1; --help discovers docs and the hermetic corpus.
// Missing or malformed coverage always fails closed (::error::, exit 1): a
// warn-and-pass would let a broken `test:coverage` step silence its own
// downstream gate. Docs-only and draft PRs skip via the ci.yml scope guard
// before this script runs, so the script itself always requires the file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLOOR = 80;

// Git C-quotes paths containing control/non-ASCII bytes, including octal UTF-8.
function diffPath(header) {
  let path = header;
  if (header.startsWith('"')) {
    const bytes = [];
    const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
    if (!header.endsWith('"')) throw new Error("git_failed");
    for (let i = 1; i < header.length - 1; i++) {
      if (header[i] !== "\\") {
        const point = header.codePointAt(i);
        bytes.push(...Buffer.from(String.fromCodePoint(point)));
        if (point > 0xffff) i++;
      } else {
        const octal = /^[0-3][0-7]{2}/.exec(header.slice(i + 1));
        if (octal) {
          bytes.push(Number.parseInt(octal[0], 8));
          i += 3;
        } else {
          const byte = escapes[header[++i]];
          if (byte === undefined) throw new Error("git_failed");
          bytes.push(byte);
        }
      }
    }
    path = Buffer.from(bytes).toString("utf8");
  }
  if (path === "/dev/null") return null;
  if (!path.startsWith("b/")) throw new Error("git_failed");
  return path.slice(2);
}

// Only an active hunk contains source. +++/--- outside it are file headers;
// inside it they are ordinary additions/removals, not a second header.
export function parseDiff(diff) {
  const added = new Map();
  let file = null;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const line of diff.split("\n")) {
    if (oldRemaining || newRemaining) {
      if (line.startsWith("\\")) continue; // No-newline marker consumes neither side.
      if (line.startsWith("+") && newRemaining > 0) {
        added.get(file).add(newLine++);
        newRemaining--;
      } else if (line.startsWith("-") && oldRemaining > 0) {
        oldRemaining--;
      } else if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
        newLine++;
        oldRemaining--;
        newRemaining--;
      } else {
        throw new Error("git_failed");
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      file = null;
    } else if (line.startsWith("+++ ")) {
      file = diffPath(line.slice(4));
      if (file !== null && !added.has(file)) added.set(file, new Set());
    } else {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!h) continue;
      if (file === null) {
        // Deleted files have no new-side lines and cannot affect coverage.
        if (Number(h[4] ?? 1) === 0) continue;
        throw new Error("git_failed");
      }
      newLine = Number(h[3]);
      oldRemaining = Number(h[2] ?? 1);
      newRemaining = Number(h[4] ?? 1);
    }
  }
  if (oldRemaining || newRemaining) throw new Error("git_failed");
  return added;
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isPosition = (value) =>
  isRecord(value) &&
  Number.isSafeInteger(value.line) &&
  value.line > 0 &&
  Number.isSafeInteger(value.column) &&
  value.column >= 0;

function requireEvidence(condition) {
  if (!condition) throw new Error("invalid_coverage");
}

function coverageFile(path, root) {
  requireEvidence(typeof path === "string" && path.length > 0 && !/[\x00-\x1f\x7f]/.test(path));
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, abs).replaceAll("\\", "/");
  requireEvidence(rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
  return rel;
}

// Admit the entire report before scoring, including unchanged files. Empty maps
// are legitimate for type-only files; missing maps/hits are not empty evidence.
// Only statement starts count, not their spans or function/branch counters.
export function lineCoverage(coverageJson, root = repoRoot) {
  requireEvidence(isRecord(coverageJson));
  const out = new Map();
  for (const [key, entry] of Object.entries(coverageJson)) {
    const rel = coverageFile(key, root);
    requireEvidence(isRecord(entry) && coverageFile(entry.path, root) === rel && !out.has(rel));
    const map = entry.statementMap;
    const hits = entry.s;
    requireEvidence(isRecord(map) && isRecord(hits));
    requireEvidence(Object.keys(map).length === Object.keys(hits).length);
    const covered = new Set();
    const statements = new Set();
    for (const [id, loc] of Object.entries(map)) {
      requireEvidence(
        isRecord(loc) &&
          isPosition(loc.start) &&
          isPosition(loc.end) &&
          (loc.end.line > loc.start.line ||
            (loc.end.line === loc.start.line && loc.end.column >= loc.start.column)),
      );
      requireEvidence(Object.hasOwn(hits, id) && Number.isSafeInteger(hits[id]) && hits[id] >= 0);
      statements.add(loc.start.line);
      if (hits[id] > 0) covered.add(loc.start.line);
    }
    out.set(rel, { covered, statements });
  }
  return out;
}

export function score(added, coverage) {
  let total = 0;
  let hit = 0;
  const addedIds = [];
  const missed = [];
  const skipped = [];
  for (const file of [...added.keys()].sort()) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const cov = coverage.get(file);
    for (const line of [...added.get(file)].sort((a, b) => a - b)) {
      addedIds.push(`${file}:${line}`);
      // Files absent from the report are fully uncovered; lines with no
      // statement (blanks, braces) are out of scope.
      if (!cov) {
        total += 1;
        missed.push(`${file}:${line}`);
      } else if (!cov.statements.has(line)) {
        skipped.push(`${file}:${line}`);
      } else {
        total += 1;
        if (cov.covered.has(line)) hit += 1;
        else missed.push(`${file}:${line}`);
      }
    }
  }
  const pct = total === 0 ? 100 : (hit / total) * 100;
  return { total, hit, pct, added: addedIds, missed, skipped };
}

// Missing input fails closed: returns 1 after an ::error:: annotation so a
// broken `test:coverage` step can never silence this gate with a skip.
// Docs-only and draft PRs keep their skip via the ci.yml scope guard, which
// skips the step before this script runs.
export function requireCoverageInput(coveragePath, exists = existsSync) {
  if (!exists(coveragePath)) {
    console.error(
      "::error::patch coverage missing input (missing_report): run npm run test:coverage first; next_action=generate_coverage",
    );
    return 1;
  }
  return 0;
}

function selftest() {
  let cases = 0;
  const check = (name, fn) => {
    fn();
    cases += 1;
    console.log(`ok: ${name}`);
  };

  check("diff parse collects added lines only", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new1",
      "+new2",
      "@@ -10 +11,0 @@",
      "-gone",
    ].join("\n");
    const added = parseDiff(diff);
    assert.deepEqual(
      [...added.get("src/a.ts")].sort((a, b) => a - b),
      [2, 3],
    );
  });

  check("score counts statements starting on added lines", () => {
    const added = new Map([["src/a.ts", new Set([2, 3, 9])]]);
    const coverage = new Map([
      ["src/a.ts", { covered: new Set([2, 9]), statements: new Set([2, 3, 9]) }],
    ]);
    const s = score(added, coverage);
    assert.equal(s.total, 3);
    assert.equal(s.hit, 2);
    assert.deepEqual(s.missed, ["src/a.ts:3"]);
    assert.ok(Math.abs(s.pct - 66.67) < 0.01);
  });

  check("added lines without a statement are skipped, not uncovered", () => {
    const added = new Map([["src/a.ts", new Set([1, 2, 3])]]);
    const coverage = new Map([["src/a.ts", { covered: new Set([2]), statements: new Set([2]) }]]);
    const s = score(added, coverage);
    assert.equal(s.total, 1);
    assert.equal(s.hit, 1);
    assert.deepEqual(s.missed, []);
    assert.deepEqual(s.skipped, ["src/a.ts:1", "src/a.ts:3"]);
  });

  check("files missing from coverage are fully uncovered", () => {
    const s = score(new Map([["src/new.ts", new Set([1])]]), new Map());
    assert.equal(s.pct, 0);
    assert.deepEqual(s.missed, ["src/new.ts:1"]);
  });

  check("empty diff scores 100 (vacuous pass)", () => {
    assert.equal(score(new Map(), new Map()).pct, 100);
  });

  check("missing coverage input fails closed instead of warn/skip", () => {
    const errors = [];
    const original = console.error;
    console.error = (message) => errors.push(message);
    try {
      assert.equal(
        requireCoverageInput("/nonexistent/coverage-final.json", () => false),
        1,
      );
      assert.equal(
        requireCoverageInput("/present/coverage-final.json", () => true),
        0,
      );
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /::error::patch coverage missing input/);
  });

  check("non-TS lines are out of scope", () => {
    const s = score(
      new Map([
        ["docs/x.md", new Set([1, 2])],
        ["ci/y.yml", new Set([5])],
      ]),
      new Map(),
    );
    assert.equal(s.total, 0);
    assert.equal(s.pct, 100);
  });

  console.log(`patch coverage selftest: ${cases} cases passed.`);
  return 0;
}

const HELP = `Usage: node ci/patch-coverage.mjs [--json] [--strict] [--base <ref>]
       node ci/patch-coverage.mjs --selftest | --help
Read-only, offline: added src/tail TS/TSX statement starts; floor 80%.
Default WARN exits 0 below the floor; --strict exits 1. Invalid/missing
coverage always exits 1; wrong/duplicate flags exit 2 before input reads.
--json emits one deterministic schema_version:1 object (no annotations).
--base defaults to origin/main; use a ref/hash, not a leading-dash option.
--help and --selftest are standalone modes; neither reads coverage or git.
Docs/schema/remediation: docs/quality-gates.md#patch-coverage-cli
Hermetic check: node --test ci/patch-coverage-acceptance.test.mjs`;

const ERRORS = {
  invalid_arguments: ["fix_arguments", "use --help for supported flags and combinations"],
  invalid_coverage: ["fix_coverage_report", "regenerate valid coverage with npm run test:coverage"],
  missing_report: ["generate_coverage", "run npm run test:coverage first"],
  git_failed: ["check_base", "check the local base ref and repository, then rerun"],
};

function emitError(code, structured) {
  const [next_action, message] = ERRORS[code];
  if (structured) {
    console.log(
      JSON.stringify({
        schema_version: 1,
        floor: FLOOR,
        verdict: "ERROR",
        error_code: code,
        next_action,
        total: null,
        hit: null,
        pct: null,
        added: [],
        missed: [],
        skipped: [],
      }),
    );
  } else {
    console.error(`::error::patch coverage ${code}: ${message}; next_action=${next_action}`);
  }
  return code === "invalid_arguments" ? 2 : 1;
}

function parseArgs(args) {
  const options = { json: false, strict: false, base: "origin/main", help: false, selftest: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--json", "--strict", "--base", "--help", "--selftest"].includes(flag) || seen.has(flag))
      throw new Error("invalid_arguments");
    seen.add(flag);
    if (flag === "--base") {
      const ref = args[++i];
      if (typeof ref !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_./@{}~^+-]*$/.test(ref))
        throw new Error("invalid_arguments");
      options.base = ref;
    } else {
      options[flag.slice(2)] = true;
    }
  }
  if ((options.help || options.selftest) && args.length !== 1) throw new Error("invalid_arguments");
  return options;
}

function readDiff(base) {
  const options = {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    maxBuffer: 64 * 1024 * 1024,
  };
  try {
    const mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], options).trim();
    return parseDiff(
      execFileSync(
        "git",
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-relative",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "-U0",
          mergeBase,
          "HEAD",
          "--",
          "src",
          "tail",
        ],
        options,
      ),
    );
  } catch {
    // Never forward Git stderr, paths, command strings or stacks to annotations.
    throw new Error("git_failed");
  }
}

function humanId(id) {
  let text = "";
  let bytes = 0;
  for (const char of id.replace(/[\x00-\x1f\x7f]/g, "?")) {
    bytes += Buffer.byteLength(char);
    if (bytes > 180) return `${text}…`;
    text += char;
  }
  return text;
}

function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch {
    return emitError("invalid_arguments", args.includes("--json"));
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.selftest) return selftest();
  const coveragePath = join(repoRoot, "coverage", "coverage-final.json");
  if (options.json) {
    if (!existsSync(coveragePath)) return emitError("missing_report", true);
  } else {
    if (requireCoverageInput(coveragePath)) return 1;
  }
  let coverage;
  try {
    coverage = lineCoverage(JSON.parse(readFileSync(coveragePath, "utf8")));
  } catch {
    // Report validation never includes input values, even in WARN mode.
    return emitError("invalid_coverage", options.json);
  }
  let added;
  try {
    added = readDiff(options.base);
  } catch {
    return emitError("git_failed", options.json);
  }
  const result = score(added, coverage);
  const { total, hit, pct, missed } = result;
  const verdict = pct >= FLOOR ? "PASS" : options.strict ? "FAIL" : "WARN";
  if (options.json) {
    console.log(
      JSON.stringify({
        schema_version: 1,
        floor: FLOOR,
        verdict,
        error_code: null,
        next_action: verdict === "PASS" ? "none" : "add_tests",
        ...result,
      }),
    );
  } else {
    console.log(
      `patch coverage: ${hit}/${total} added TS lines covered (${pct.toFixed(1)}%, floor ${FLOOR}%).`,
    );
    // Bound human output by both line count and length; never admit a control
    // character from a path into a new annotation. JSON retains complete IDs.
    for (const id of missed.slice(0, 30)) console.log(`uncovered: ${humanId(id)}`);
    if (missed.length > 30) console.log(`... and ${missed.length - 30} more uncovered lines.`);
    if (pct < FLOOR) {
      console.log(
        `::warning::patch coverage ${pct.toFixed(1)}% is under the ${FLOOR}% floor (${missed.length} uncovered added lines)`,
      );
    }
  }
  return verdict === "FAIL" ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
