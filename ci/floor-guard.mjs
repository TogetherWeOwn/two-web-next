#!/usr/bin/env node
// floor-guard.mjs — diff-scoped enforcement of the CONSTRAINTS.md floor.
//
// The literal CONSTRAINTS.md name in this header keeps ci/change-scope.sh
// treating floor edits as gate inputs, not prose: a CONSTRAINTS.md-only
// change still runs the full suite.
//
// Detects the five bar-lowering moves: a weakened threshold in
// CONSTRAINTS.md, a test made easier (skip added, test file deleted,
// assertion stripped from a surviving test), a silenced checker (a new
// suppression comment), unfinished work (a stub), a new Exceptions row.
// Tightening the bar is silent; loosening it fails.
//
// Usage: node ci/floor-guard.mjs [--base <ref>]   (default base: origin/main)
// Exit codes: 0 clean, 1 at least one floor violation, 2 guard could not run.
// A 2 must never read as a 0.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Silenced checker — extend for the ecosystem; biome-ignore is this repo's form.
const SUPPRESSIONS =
  /@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|# *noqa|# *type: *ignore|istanbul ignore|nosemgrep|gitleaks:allow|Stryker disable/;
// Unfinished work.
const STUBS =
  /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*\(\w*\)\s*\{\s*\}|catch\s*\{\s*\}|\bTODO\b|\bpass\s*# *stub/;
// A test made easier (added skips).
const SKIPS = /\.(skip|todo)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|t\.Skip\(/;
const TEST_PATH = /\.(test|spec)\.|_test\.|test_/;
const CONSTRAINTS_FILE = /CONSTRAINTS\.md$/;
const ASSERTIONS = /\b(expect|assert|should)\b/;

const stripPrefix = (p) => p.replace(/^[ab]\//, "");

// Parse a unified diff into added/removed lines plus deleted file paths.
// Handles `+++ b/<path>` attribution, `+++ /dev/null` deletions, and the
// `git diff --no-index /dev/null <f>` form used for untracked files.
export function parseDiff(diff) {
  const added = [];
  const removed = [];
  const deletedFiles = [];
  let file = "";
  let lastMinus = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      lastMinus = line.slice(4).trim();
    } else if (line.startsWith("+++ ")) {
      const plus = line.slice(4).trim();
      if (plus === "/dev/null") {
        if (lastMinus && lastMinus !== "/dev/null") deletedFiles.push(stripPrefix(lastMinus));
        file = "";
      } else {
        file = stripPrefix(plus);
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ file, text: line.slice(1) });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed.push({ file, text: line.slice(1) });
    }
  }
  return { added, removed, deletedFiles };
}

const flag = (findings, rule, file, text) =>
  findings.push({ rule, file, text: text.trim().slice(0, 120) });

// A .constraintsignore at the repo root (one glob per line, `#` comments)
// exempts a path from the added-line content rules only — the guard's own
// pattern lists must name the forms they detect. Thresholds, exception rows
// and deleted tests are never ignorable: exempting those would silence the
// bar itself rather than a false positive.
export function globToRegExp(glob) {
  return new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
}

export function loadIgnore(root) {
  const p = join(root, ".constraintsignore");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function scanAdded(added, ignore = []) {
  const findings = [];
  const ignored = ignore.map(globToRegExp);
  for (const { file, text } of added) {
    // Exception rows are never ignorable, even when the file is listed.
    if (CONSTRAINTS_FILE.test(file) && /^\| *(W|E)\d+ *\|/.test(text))
      flag(findings, "new-exception", file, text);
    if (ignored.some((re) => re.test(file))) continue;
    if (SUPPRESSIONS.test(text)) flag(findings, "silenced-checker", file, text);
    if (STUBS.test(text)) flag(findings, "unfinished-work", file, text);
    if (SKIPS.test(text)) flag(findings, "test-made-easier", file, text);
  }
  return findings;
}

// A removed assertion paired with an assertion added in the same test file
// is a replacement (strengthening), not a strip: only the net excess is
// flagged, so a vacuous placeholder can be swapped for a real pin without
// tripping the floor, while a genuine strip stays loud.
export function scanRemoved(removed, added = []) {
  const findings = [];
  const addedAssert = new Map();
  for (const { file, text } of added) {
    if (TEST_PATH.test(file) && ASSERTIONS.test(text))
      addedAssert.set(file, (addedAssert.get(file) ?? 0) + 1);
  }
  const paired = new Map();
  for (const { file, text } of removed) {
    if (TEST_PATH.test(file) && ASSERTIONS.test(text)) {
      const used = paired.get(file) ?? 0;
      if (used < (addedAssert.get(file) ?? 0)) {
        paired.set(file, used + 1);
        continue;
      }
      flag(findings, "assertion-removed", file, text);
    }
  }
  return findings;
}

export function scanDeleted(deletedFiles) {
  const findings = [];
  for (const file of deletedFiles) {
    if (TEST_PATH.test(file)) flag(findings, "test-deleted", file, "(test file deleted)");
  }
  return findings;
}

// A number in CONSTRAINTS.md that went down (paired by row label); a number
// that went up is a tightening and stays silent.
export function checkThresholds(removed, added) {
  const findings = [];
  const nums = (s) => (s.match(/\d+(\.\d+)?/g) || []).map(Number);
  const removedConstraints = removed.filter((l) => CONSTRAINTS_FILE.test(l.file));
  const addedConstraints = added.filter((l) => CONSTRAINTS_FILE.test(l.file));
  for (const r of removedConstraints) {
    const a = addedConstraints.find((x) => x.text.split(/[|:]/)[0] === r.text.split(/[|:]/)[0]);
    if (a && nums(a.text).some((n, i) => nums(r.text)[i] !== undefined && n < nums(r.text)[i])) {
      flag(findings, "threshold-lowered", r.file, `${r.text}  ->  ${a.text}`);
    }
  }
  return findings;
}

export function guardDiff(diff, opts = {}) {
  const { added, removed, deletedFiles } = parseDiff(diff);
  return [
    ...scanAdded(added, opts.ignore ?? []),
    ...scanRemoved(removed, added),
    ...scanDeleted(deletedFiles),
    ...checkThresholds(removed, added),
  ];
}

function main() {
  const argv = process.argv.slice(2);
  const base = (() => {
    const i = argv.indexOf("--base");
    return i > -1 && argv[i + 1] ? argv[i + 1] : "origin/main";
  })();

  // spawnSync, not execFileSync: `git diff` exits 1 whenever a diff exists,
  // and execFileSync discards stdout on non-zero exit — which would make the
  // guard blind to every violation and always report clean.
  const git = (args) => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.error) return null;
    return r.stdout ?? "";
  };

  // Merge base; bail to exit 2 rather than pretending a shallow or
  // rootless clone is clean.
  const mergeBase = git(["merge-base", base, "HEAD"])?.trim();
  if (!mergeBase) {
    console.error(`floor-guard: no merge base against ${base}`);
    process.exit(2);
  }

  // Unified diff plus untracked files (git diff alone cannot see new files).
  const tracked = git(["diff", "--unified=0", mergeBase, "--"]) ?? "";
  const untracked = (git(["ls-files", "--others", "--exclude-standard"]) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((f) => git(["diff", "--no-index", "--unified=0", "/dev/null", f]) ?? "")
    .join("\n");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const findings = guardDiff(`${tracked}\n${untracked}`, { ignore: loadIgnore(repoRoot) });

  if (findings.length === 0) {
    console.log("floor-guard: clean");
    process.exit(0);
  }
  console.error(`floor-guard: ${findings.length} floor violation(s):`);
  for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
  console.error(
    "\nEach is a move that lowers the bar. Fix the code, or route it through a tracked exception.",
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
