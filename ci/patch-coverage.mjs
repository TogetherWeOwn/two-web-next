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
// A missing coverage input always fails closed (::error::, exit 1): a
// warn-and-pass would let a broken `test:coverage` step silence its own
// downstream gate. Docs-only and draft PRs skip via the ci.yml scope guard
// before this script runs, so the script itself always requires the file.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLOOR = 80;

// Parse `git diff -U0` into added line numbers per repo-relative file.
export function parseDiff(diff) {
  const added = new Map();
  let file = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line);
    if (m) {
      file = m[2];
      added.set(file, new Set());
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      newLine = Number(h[1]);
      continue;
    }
    if (file === null || file === "/dev/null") continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.get(file)?.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Removed line: no new-side line consumed.
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file": no line consumed.
    } else {
      // Context line (only possible with -U>0, kept for robustness).
      newLine += 1;
    }
  }
  return added;
}

// Per-file line data from a v8 coverage-final.json: every statement's start
// line, split into covered (hits > 0) and all. Only statement lines count:
// blanks, braces and type-only lines can never be "uncovered".
export function lineCoverage(coverageJson, root = repoRoot) {
  const out = new Map();
  for (const [key, entry] of Object.entries(coverageJson)) {
    const abs = isAbsolute(key) ? key : join(root, key);
    const rel = relative(root, abs).replaceAll("\\", "/");
    const covered = new Set();
    const statements = new Set();
    const map = entry.statementMap ?? {};
    const hits = entry.s ?? {};
    for (const [id, loc] of Object.entries(map)) {
      if (!loc?.start?.line) continue;
      statements.add(loc.start.line);
      if ((hits[id] ?? 0) > 0) covered.add(loc.start.line);
    }
    out.set(rel, { covered, statements });
  }
  return out;
}

export function score(added, coverage) {
  let total = 0;
  let hit = 0;
  const missed = [];
  const skipped = [];
  for (const [file, lines] of added) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const cov = coverage.get(file);
    for (const line of [...lines].sort((a, b) => a - b)) {
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
  return { total, hit, pct, missed, skipped };
}

// Missing input fails closed: returns 1 after an ::error:: annotation so a
// broken `test:coverage` step can never silence this gate with a skip.
// Docs-only and draft PRs keep their skip via the ci.yml scope guard, which
// skips the step before this script runs.
export function requireCoverageInput(coveragePath, exists = existsSync) {
  if (!exists(coveragePath)) {
    console.error(
      `::error::patch coverage missing input: ${coveragePath} absent (run npm run test:coverage first)`,
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter(
    (a, i) => a !== "--selftest" && a !== "--strict" && a !== "--base" && args[i - 1] !== "--base",
  );
  if (unknown.length) {
    console.error("Usage: node ci/patch-coverage.mjs [--selftest] [--strict] [--base <ref>]");
    process.exitCode = 2;
  } else if (args.includes("--selftest")) {
    process.exitCode = selftest();
  } else {
    const baseIdx = args.indexOf("--base");
    const base = baseIdx >= 0 ? args[baseIdx + 1] : "origin/main";
    const coveragePath = join(repoRoot, "coverage", "coverage-final.json");
    if (requireCoverageInput(coveragePath)) {
      process.exitCode = 1;
    } else {
      const mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      const diff = execSync(`git diff -U0 ${mergeBase} HEAD -- src tail`, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      const coverageJson = JSON.parse(readFileSync(coveragePath, "utf8"));
      const { total, hit, pct, missed } = score(parseDiff(diff), lineCoverage(coverageJson));
      console.log(
        `patch coverage: ${hit}/${total} added TS lines covered (${pct.toFixed(1)}%, floor ${FLOOR}%).`,
      );
      for (const m of missed.slice(0, 30)) console.log(`uncovered: ${m}`);
      if (missed.length > 30) console.log(`... and ${missed.length - 30} more uncovered lines.`);
      if (pct < FLOOR) {
        console.log(
          `::warning::patch coverage ${pct.toFixed(1)}% is under the ${FLOOR}% floor (${missed.length} uncovered added lines)`,
        );
        if (args.includes("--strict")) process.exitCode = 1;
      }
    }
  }
}
