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
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
// *-selftest scripts are CI-executed checks too (ci/*-selftest.mjs, .sh and
// extensionless forms, plus dotted and nested variants such as
// ci/release-on-promote.selftest.cjs and ci/backup-restore-proof/selftest.py),
// so deleting or stripping them trips the same floor as a *.test.* file.
const TEST_PATH = /\.(test|spec)\.|_test\.|test_|[-./]selftest(?=\.|$)/;
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
    const match = line.match(
      /^Floor-waiver: (assertion-removed|test-deleted|threshold-removed|new-exemption) (\S+) -- (.+)$/,
    );
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

// A number in CONSTRAINTS.md that went down. Rows pair by label first; a row
// whose label vanished pairs by its Checked-by cell, so renaming a dimension
// while lowering it still reads as a lowering. An enforced row (one whose
// Checked-by cell names a command in backticks, and which is not an exception
// row) with no successor at all is a removal of the bar itself. Header,
// separator, exception and non-command rows are not enforced rows. A
// legitimate rename or removal passes only with a reasoned
// `Floor-waiver: threshold-removed <Dimension> -- <reason>` trailer.
export function checkThresholds(removed, added, waivers = new Map()) {
  const findings = [];
  const nums = (s) => (s.match(/\d+(\.\d+)?/g) || []).map(Number);
  const cells = (text) =>
    text
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
  const label = (text) => cells(text)[0] ?? "";
  const checkedBy = (text) => cells(text)[2] ?? "";
  const isEnforcedRow = (text) => {
    const kind = label(text);
    if (!kind || /^-+$/.test(kind) || /^dimension$/i.test(kind)) return false;
    if (/^\s*\|\s*(W|E)\d+\s*\|/.test(text)) return false;
    return /`[^`]+`/.test(checkedBy(text));
  };
  const isLowered = (before, after) => {
    const b = nums(before);
    return nums(after).some((n, i) => b[i] !== undefined && n < b[i]);
  };
  const removedRows = removed.filter((l) => CONSTRAINTS_FILE.test(l.file) && isEnforcedRow(l.text));
  const addedRows = added.filter((l) => CONSTRAINTS_FILE.test(l.file) && isEnforcedRow(l.text));
  const addedByLabel = new Map();
  const addedByCheckedBy = new Map();
  for (const line of addedRows) {
    if (!addedByLabel.has(label(line.text))) addedByLabel.set(label(line.text), line);
    const key = checkedBy(line.text);
    if (key && !addedByCheckedBy.has(key)) addedByCheckedBy.set(key, line);
  }
  const paired = new Set();
  for (const r of removedRows) {
    const key = label(r.text);
    const sameLabel = addedByLabel.get(key);
    if (sameLabel) {
      if (isLowered(r.text, sameLabel.text))
        flag(findings, "threshold-lowered", r.file, `${r.text}  ->  ${sameLabel.text}`);
      continue;
    }
    const sameCheck = addedByCheckedBy.get(checkedBy(r.text));
    if (sameCheck && !paired.has(sameCheck)) {
      paired.add(sameCheck);
      if (isLowered(r.text, sameCheck.text))
        flag(findings, "threshold-lowered", r.file, `${r.text}  ->  ${sameCheck.text}`);
      continue;
    }
    if (waivers.get("threshold-removed")?.has(key)) continue;
    flag(findings, "threshold-removed", r.file, r.text);
  }
  return findings;
}

// Added `.constraintsignore` lines are new exemptions from the HARD gate, so
// they fail unless a reasoned `Floor-waiver: new-exemption .constraintsignore
// -- <reason>` trailer covers the file. Comment and blank lines are not
// exemptions. `baseIgnore` is the ignore list at the merge base: entries that
// predate the branch are grandfathered, entries the branch adds are flagged.
export function scanIgnoreAdditions(added, baseIgnore = [], waivers = new Map()) {
  const findings = [];
  if (waivers.get("new-exemption")?.has(".constraintsignore")) return findings;
  const base = new Set(baseIgnore);
  for (const { file, text } of added) {
    if (!/\.constraintsignore$/.test(file)) continue;
    const line = text.trim();
    if (!line || line.startsWith("#") || base.has(line)) continue;
    flag(findings, "new-exemption", file, line);
  }
  return findings;
}

export function guardDiff(diff, opts = {}) {
  const { added, removed, deletedFiles } = parseDiff(diff);
  const waivers = opts.waivers ?? new Map();
  return [
    ...scanAdded(added, opts.ignore ?? []),
    ...scanIgnoreAdditions(added, opts.baseIgnore ?? [], waivers),
    ...scanRemoved(removed, added, waivers),
    ...scanDeleted(deletedFiles, waivers),
    ...checkThresholds(removed, added, waivers),
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

  // Every active waiver is surfaced in the log and the job summary, so a
  // self-approved exemption is visible to the reviewer, not silent.
  if (waivers.size > 0) {
    const lines = [...waivers.entries()].flatMap(([rule, files]) =>
      [...files].map((f) => `Floor-waiver: ${rule} ${f}`),
    );
    console.log(`floor-guard: ${lines.length} waiver trailer(s) active:`);
    for (const l of lines) console.log(`  ${l}`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) {
      try {
        appendFileSync(
          summary,
          `### floor-guard waivers\n\n${lines.map((l) => `- \`${l}\``).join("\n")}\n`,
        );
      } catch {
        console.log("floor-guard: could not append waivers to the job summary");
      }
    }
  }

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
  // The ignore list is pinned to the merge base: entries the branch adds take
  // effect only behind a reasoned new-exemption waiver (flagged by
  // scanIgnoreAdditions otherwise), so an author cannot silently waive the
  // HARD gate with an ignore edit. A missing file at the base is not an
  // error; it means nothing is grandfathered.
  const baseIgnore = (git(["show", `${mergeBase}:.constraintsignore`]) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const treeIgnore = loadIgnore(repoRoot);
  const ignore = waivers.get("new-exemption")?.has(".constraintsignore")
    ? [...new Set([...baseIgnore, ...treeIgnore])]
    : baseIgnore;
  const findings = guardDiff(`${tracked}\n${untracked}`, {
    ignore,
    baseIgnore,
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
