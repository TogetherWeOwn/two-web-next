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
// Unfinished work in source and test code; generated output and prose are not
// reliable places to distinguish a real stub from a string or explanation.
const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|sh|go|rs)$/i;
const STUBS =
  /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*\(\w*\)\s*\{\s*\}|catch\s*\{\s*\}|\bTODO\b|\bpass\s*# *stub/;
// Only test skip calls weaken the test floor; property reads and prose do not.
const TEST_SKIP_CALL =
  /\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe)\s*\(|@pytest\.mark\.skip\s*\(|\bt\.Skip\s*\(/;
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
    if (CODE_PATH.test(file) && STUBS.test(text)) flag(findings, "unfinished-work", file, text);
    if (CODE_PATH.test(file) && TEST_PATH.test(file) && TEST_SKIP_CALL.test(text))
      flag(findings, "test-made-easier", file, text);
  }
  return findings;
}

// A removed assertion paired with an assertion added in the same test file
// is a replacement (strengthening), not a strip: only the net excess is
// flagged, so a vacuous placeholder can be swapped for a real pin without
// tripping the floor, while a genuine strip stays loud.
export function parseFloorWaivers(messages) {
  const waivers = new Map();
  for (const line of messages.split(/\r?\n/)) {
    const match = line.match(/^Floor-waiver: (assertion-removed|test-deleted) (\S+) -- (.+)$/);
    if (!match || !match[3].trim()) continue;
    const [, rule, file] = match;
    if (!waivers.has(rule)) waivers.set(rule, new Set());
    waivers.get(rule).add(file);
  }
  return waivers;
}

export function scanRemoved(removed, added = [], waivers = new Map()) {
  const findings = [];
  const addedAssert = new Map();
  for (const { file, text } of added) {
    if (TEST_PATH.test(file) && ASSERTIONS.test(text))
      addedAssert.set(file, (addedAssert.get(file) ?? 0) + 1);
  }
  const paired = new Map();
  for (const { file, text } of removed) {
    if (TEST_PATH.test(file) && ASSERTIONS.test(text)) {
      if (waivers.get("assertion-removed")?.has(file)) continue;
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

export function scanDeleted(deletedFiles, waivers = new Map()) {
  const findings = [];
  for (const file of deletedFiles) {
    if (TEST_PATH.test(file) && !waivers.get("test-deleted")?.has(file))
      flag(findings, "test-deleted", file, "(test file deleted)");
  }
  return findings;
}

// A number in CONSTRAINTS.md that went down (paired by row label); a number
// that went up is a tightening and stays silent.
export function checkThresholds(removed, added) {
  const findings = [];
  const nums = (s) => (s.match(/\d+(\.\d+)?/g) || []).map(Number);
  const label = (text) => text.match(/^\s*\|\s*([^|]+?)\s*\|/)?.[1]?.trim();
  const removedConstraints = removed.filter((l) => CONSTRAINTS_FILE.test(l.file));
  const addedConstraints = added.filter((l) => CONSTRAINTS_FILE.test(l.file));
  const addedByLabel = new Map();
  for (const line of addedConstraints) {
    const key = label(line.text);
    if (key) addedByLabel.set(key, line);
  }
  for (const r of removedConstraints) {
    const key = label(r.text);
    const a = key ? addedByLabel.get(key) : null;
    if (!a) continue;
    const before = nums(r.text);
    if (nums(a.text).some((n, i) => before[i] !== undefined && n < before[i])) {
      flag(findings, "threshold-lowered", r.file, `${r.text}  ->  ${a.text}`);
    }
  }
  return findings;
}

export function guardDiff(diff, opts = {}) {
  const { added, removed, deletedFiles } = parseDiff(diff);
  return [
    ...scanAdded(added, opts.ignore ?? []),
    ...scanRemoved(removed, added, opts.waivers ?? new Map()),
    ...scanDeleted(deletedFiles, opts.waivers ?? new Map()),
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
  const git = (args, allowDiff = false) => {
    const r = spawnSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error || (r.status !== 0 && !(allowDiff && r.status === 1))) return null;
    return r.stdout ?? "";
  };

  // Merge base; bail to exit 2 rather than pretending a shallow or
  // rootless clone is clean.
  const mergeBase = git(["merge-base", base, "HEAD"])?.trim();
  if (!mergeBase) {
    console.error(`floor-guard: no merge base against ${base}`);
    process.exit(2);
  }

  const commitMessages = git(["log", "--format=%B", `${mergeBase}..HEAD`]);
  if (commitMessages === null) {
    console.error("floor-guard: could not read commit messages");
    process.exit(2);
  }
  const waivers = parseFloorWaivers(commitMessages);

  // Unified diff plus untracked files (git diff alone cannot see new files).
  // Any failed diff is a guard failure, never an empty/clean result.
  const tracked = git(["diff", "--unified=0", mergeBase, "--"], true);
  const untrackedFiles = git(["ls-files", "--others", "--exclude-standard"]);
  if (tracked === null || untrackedFiles === null) {
    console.error("floor-guard: could not read the repository diff");
    process.exit(2);
  }
  const untrackedParts = untrackedFiles
    .split("\n")
    .filter(Boolean)
    .map((f) => git(["diff", "--no-index", "--unified=0", "/dev/null", f], true));
  if (untrackedParts.some((part) => part === null)) {
    console.error("floor-guard: could not read an untracked file diff");
    process.exit(2);
  }
  const untracked = untrackedParts.join("\n");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const findings = guardDiff(`${tracked}\n${untracked}`, {
    ignore: loadIgnore(repoRoot),
    waivers,
  });

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
