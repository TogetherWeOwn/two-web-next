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
// Conditional (gated) skips weaken it too: `.skipIf(`/`.runIf(` calls (and
// pytest's `skipif`), an options-object `skip:` (on its own line under a test
// call the zero-context diff cannot see, or inline in the call's options), and
// ternary suite/test selection that routes to a `.skip`/`.todo` member
// (`cond ? describe : describe.skip`). A direct alias of that member
// (`const suite = describe.skip`) is unconditional, so it joins
// TEST_SKIP_CALL below rather than the conditional tier. The member and
// inline-option forms name the suite/test functions only, so property reads
// (`entry.skip`), prose and inline data objects (`{ "/health": { skip: true }
// }`) stay silent. Values are never evaluated, matching TEST_SKIP_CALL: the
// guard is syntactic. Conditional adds pair against skips removed from the
// same file in scanAdded; unconditional adds never pair, so gating a skip
// that was unconditional (or swapping one gated form for another) is silent
// while replacing a gated form with an unconditional skip still flags.
const CONDITIONAL_SKIP_CALL = /\.(?:skipIf|runIf|skipif)\s*\(/;
const SUITE_OR_TEST = String.raw`(?:describe|context|suite|it|test)(?:\.\w+)*`;
const SKIP_OPTION_LINE = /^\s*["']?skip["']?\s*:/;
const SKIP_OPTION_INLINE = new RegExp(
  String.raw`\b${SUITE_OR_TEST}\s*\([^\n]*\{\s*(?:[^{}]*,\s*)?["']?skip["']?\s*:`,
);
const SKIP_MEMBER_TERNARY = new RegExp(
  String.raw`\?\s*(?:${SUITE_OR_TEST}\.(?:skip|todo)\b|[^?:]*:\s*${SUITE_OR_TEST}\.(?:skip|todo)\b)`,
);
const SKIP_MEMBER_ALIAS = new RegExp(
  String.raw`(?:(?<![=!<>])=(?![=>])|\breturn\b)\s*${SUITE_OR_TEST}\.(?:skip|todo)\s*(?=[;,)\]]|$)`,
);
const isConditionalSkip = (text) =>
  CONDITIONAL_SKIP_CALL.test(text) ||
  SKIP_OPTION_LINE.test(text) ||
  SKIP_OPTION_INLINE.test(text) ||
  SKIP_MEMBER_TERNARY.test(text);
const isUnconditionalSkip = (text) => TEST_SKIP_CALL.test(text) || SKIP_MEMBER_ALIAS.test(text);
// *-selftest scripts are CI-executed checks too (ci/*-selftest.mjs, .sh and
// extensionless forms, plus dotted and nested variants such as
// ci/release-on-promote.selftest.cjs and ci/backup-restore-proof/selftest.py),
// so deleting or stripping them trips the same floor as a *.test.* file.
const TEST_PATH = /\.(test|spec)\.|_test\.|test_|[-./]selftest(?=\.|$)/;
const CONSTRAINTS_FILE = /CONSTRAINTS\.md$/;
const ASSERTIONS = /\b(expect|assert|should)\b/;

const stripPrefix = (p) => p.replace(/^[ab]\//, "");

// Runner globs, not name patterns, decide whether a moved test still runs.
// Vitest includes test/**/*.test.ts, test/**/*.test.mjs and
// ci/audit-lifecycle.test.mjs (vitest.config.ts); the report-only Tier-0
// suites include only tier0/**/*.test.ts (tier0/vitest.config.ts). Playwright
// e2e specs run via testMatch **/*.spec.ts under testDir ./e2e
// (playwright.config.ts), so a spec moved out of e2e/ no longer runs. The e2e
// safety scripts run via an explicit list in package.json
// (`node --test e2e/safety.test.mjs e2e/qa-request.test.mjs ...`); `node
// --test a b` silently skips a missing path and exits 0, so any rename of a
// listed script breaks the wiring even when the new name matches the same
// pattern. Likewise most ci selftests run via explicit single paths
// (`node --test ci/cutover-check-selftest.mjs`); only ci/a11y-*.test.mjs runs
// via a shell glob, so only a rename within that glob keeps running. The
// vitest-run audit lifecycle suite (ci/audit-lifecycle.test.mjs) is named
// exactly by the a11y job and the vitest include, so any rename of it breaks
// the wiring. A rename whose source is runnable but whose destination leaves
// the runner (docs/ move, suffix change, out-of-glob rename, or rewiring
// rename) is a deletion from the suite, even though the name still looks
// like a test.
const VITEST_RE = /^test\/.*\.test\.(ts|mjs)$/;
// Tier-0 suites run from tier0/ through their own vitest config
// (tier0/vitest.config.ts, `npm run test:tier0`), report-only. A move out of
// tier0/ unwires them, and a move across the test/tier0 boundary promotes
// report-only to blocking (or demotes blocking to report-only), so every
// such move trips the same floor as a move out of test/.
const TIER0_RE = /^tier0\/.*\.test\.ts$/;
const E2E_SPEC_RE = /^e2e\/.*\.spec\.ts$/;
const E2E_SAFETY_RE = /^e2e\/.*\.test\.mjs$/;
const CI_A11Y_RE = /^ci\/a11y-.*\.test\.mjs$/;
const isCiSelftest = (p) => p.startsWith("ci/") && TEST_PATH.test(p) && CODE_PATH.test(p);

function stillRunnable(from, to) {
  if (VITEST_RE.test(from)) return VITEST_RE.test(to);
  if (TIER0_RE.test(from)) return TIER0_RE.test(to);
  if (E2E_SPEC_RE.test(from)) return E2E_SPEC_RE.test(to);
  // Enumerated runners fail closed: any rename needs a test-deleted waiver.
  if (E2E_SAFETY_RE.test(from)) return to === from;
  if (isCiSelftest(from)) {
    if (CI_A11Y_RE.test(from)) return CI_A11Y_RE.test(to);
    return to === from;
  }
  return TEST_PATH.test(to) && CODE_PATH.test(to);
}

// Parse a unified diff into added/removed lines plus deleted file paths.
// Handles `+++ b/<path>` attribution, `+++ /dev/null` deletions, and the
// `git diff --no-index /dev/null <f>` form used for untracked files.
// Git's default rename detection turns a `git mv` into `rename from X` /
// `rename to Y` headers: a 100% rename carries no ---/+++ lines at all and a
// partial rename attributes its hunks to the destination, so both forms are
// handled here. A move whose source is a test path but whose destination no
// longer runs under the runner globs (non-test path, a non-runner suffix such
// as `*.test.ts.disabled`, or a test-looking name outside the runner globs
// such as `docs/a.test.ts` or `test/a.test.js`) counts as a deletion and
// needs the usual `test-deleted` waiver. Removed lines in a renamed file keep
// the destination as their pairing key and carry the old path separately, so
// `assertion-removed` still pairs a one-for-one swap in a moved test; the
// test-path check, waiver lookup and finding label read the origin. A move
// that keeps a runnable test path stays silent.
export function parseDiff(diff) {
  const added = [];
  const removed = [];
  const deletedFiles = [];
  let file = "";
  let lastMinus = "";
  let renameFrom = "";
  const unquote = (p) => p.replace(/^"(.*)"$/, "$1");
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = "";
      lastMinus = "";
      renameFrom = "";
    } else if (line.startsWith("rename from ")) {
      renameFrom = unquote(line.slice("rename from ".length).trim());
    } else if (line.startsWith("rename to ")) {
      const renameTo = unquote(line.slice("rename to ".length).trim());
      if (renameFrom && TEST_PATH.test(renameFrom) && !stillRunnable(renameFrom, renameTo)) {
        deletedFiles.push(renameFrom);
      }
      // A pure move of the floor file carries no hunks, so no threshold row is
      // ever examined: leaving the CONSTRAINTS.md name blinds every
      // CONSTRAINTS check on this and later diffs. Treat it as deleting the
      // floor file, cleared by the same threshold-removed waiver.
      if (renameFrom && CONSTRAINTS_FILE.test(renameFrom) && !CONSTRAINTS_FILE.test(renameTo)) {
        deletedFiles.push(renameFrom);
      }
    } else if (line.startsWith("--- ")) {
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
      // In a renamed file the hunk keeps the destination as its pairing key
      // and carries the old path separately; in a pure deletion (file reset
      // to "") there is no origin, so a deleted test reports test-deleted
      // only, not assertion-removed on top.
      removed.push({
        file,
        from: renameFrom && file ? renameFrom : undefined,
        text: line.slice(1),
      });
    }
  }
  return { added, removed, deletedFiles };
}

const flag = (findings, rule, file, text) =>
  findings.push({ rule, file, text: text.trim().slice(0, 120) });

// A .constraintsignore at the repo root (one glob per line, `#` comments)
// exempts a path from the suppression and stub content rules only — the
// guard's own pattern lists must name the forms they detect. Test skips,
// thresholds, exception rows and deleted tests are never ignorable:
// exempting those would silence the bar itself rather than a false positive.
// The guard's own test file is listed so its pattern literals and fixtures do
// not trip silenced-checker or unfinished-work; its fixtures avoid the
// contiguous skip literal so a real skip added there still fails.
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

export function scanAdded(added, ignore = [], removed = []) {
  const findings = [];
  const ignored = ignore.map(globToRegExp);
  // A conditional skip paired with a skip removed from the same test file is
  // a replacement (a retitled gated suite, one gated form swapped for
  // another, an unconditional skip made conditional), not an addition: only
  // the net excess is flagged, mirroring the assertion pairing in
  // scanRemoved. Removed lines pair by their destination path, so a swap in
  // a renamed test still pairs; unconditional adds never consume a pair, so
  // replacing a gated form with a plain skip stays loud.
  const removedSkips = new Map();
  for (const { file, from, text } of removed) {
    const origin = from ?? file;
    if (
      file &&
      CODE_PATH.test(origin) &&
      TEST_PATH.test(origin) &&
      (isUnconditionalSkip(text) || isConditionalSkip(text))
    )
      removedSkips.set(file, (removedSkips.get(file) ?? 0) + 1);
  }
  const pairedSkips = new Map();
  for (const { file, text } of added) {
    // Exception rows are never ignorable, even when the file is listed.
    if (CONSTRAINTS_FILE.test(file) && /^\| *(W|E)\d+ *\|/.test(text))
      flag(findings, "new-exception", file, text);
    const isIgnored = ignored.some((re) => re.test(file));
    if (!isIgnored) {
      if (SUPPRESSIONS.test(text)) flag(findings, "silenced-checker", file, text);
      if (CODE_PATH.test(file) && STUBS.test(text)) flag(findings, "unfinished-work", file, text);
    }
    // Test skips always run, even for ignored paths: ignoring the guard's own
    // test file must not hide a real skip added there.
    if (CODE_PATH.test(file) && TEST_PATH.test(file)) {
      if (isUnconditionalSkip(text)) {
        flag(findings, "test-made-easier", file, text);
      } else if (isConditionalSkip(text)) {
        const used = pairedSkips.get(file) ?? 0;
        if (used < (removedSkips.get(file) ?? 0)) pairedSkips.set(file, used + 1);
        else flag(findings, "test-made-easier", file, text);
      }
    }
  }
  return findings;
}

// A removed assertion paired with an assertion added in the same test file
// is a replacement (strengthening), not a strip: only the net excess is
// flagged, so a vacuous placeholder can be swapped for a real pin without
// tripping the floor, while a genuine strip stays loud.
// Merge-queue squash messages hard-wrap the PR body at ~72 columns, so a
// long `Floor-waiver:` trailer arrives as a first line plus non-blank
// continuation lines. Unfold those continuations before matching, or a
// verbatim body waiver would pass pr-lint yet fail floor-guard in the queue.
// Real paths never contain spaces, so wrap-inserted spaces inside the path
// are stripped; reason whitespace collapses to single spaces.
export function unfoldFloorWaiverLines(messages) {
  const lines = messages.split(/\r?\n/);
  const unfolded = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^Floor-waiver:/.test(line)) {
      let block = line;
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "" && !/^Floor-waiver:/.test(lines[j])) {
        block += ` ${lines[j].trim()}`;
        j++;
      }
      unfolded.push(block);
      i = j - 1;
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

export function parseFloorWaivers(messages) {
  const waivers = new Map();
  for (const raw of unfoldFloorWaiverLines(messages)) {
    const line = raw.replace(/\s+/g, " ").trim();
    // threshold-removed names a full table label, which usually has spaces
    // ("Coverage of changed lines"), so it takes the whole text up to the
    // reason separator. The path-based rules target single paths
    // (test/a.test.ts, .constraintsignore): the middle group allows spaces so
    // a mid-path wrap still parses, then wrap-inserted spaces are stripped.
    const labelMatch = line.match(/^Floor-waiver: threshold-removed (.+?) -- (.+)$/);
    if (labelMatch && labelMatch[1].trim() && labelMatch[2].trim()) {
      if (!waivers.has("threshold-removed")) waivers.set("threshold-removed", new Set());
      waivers.get("threshold-removed").add(labelMatch[1].trim());
      continue;
    }
    const match = line.match(
      /^Floor-waiver: (assertion-removed|test-deleted|new-exemption) (.+?) -- (.+)$/,
    );
    if (!match || !match[3].trim()) continue;
    const [, rule, pathCandidate] = match;
    const file = pathCandidate.replace(/\s+/g, "");
    if (!file) continue;
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
  for (const { file, from, text } of removed) {
    // Pairing stays keyed by the destination (where the replacement lands);
    // the test-path check, waiver lookup and finding label read the origin.
    const origin = from ?? file;
    if (TEST_PATH.test(origin) && ASSERTIONS.test(text)) {
      if (waivers.get("assertion-removed")?.has(origin)) continue;
      const used = paired.get(file) ?? 0;
      if (used < (addedAssert.get(file) ?? 0)) {
        paired.set(file, used + 1);
        continue;
      }
      flag(findings, "assertion-removed", origin, text);
    }
  }
  return findings;
}

export function scanDeleted(deletedFiles, waivers = new Map()) {
  const findings = [];
  for (const file of deletedFiles) {
    if (TEST_PATH.test(file) && !waivers.get("test-deleted")?.has(file))
      flag(findings, "test-deleted", file, "(test file deleted)");
    // Deleting CONSTRAINTS.md removes every enforced threshold at once: the
    // per-row hunks carry file "" so checkThresholds never sees them, and the
    // path only lands here. A legitimate removal passes only with a reasoned
    // `Floor-waiver: threshold-removed CONSTRAINTS.md -- <reason>` trailer.
    if (
      CONSTRAINTS_FILE.test(file) &&
      !waivers.get("threshold-removed")?.has(file) &&
      !waivers.get("threshold-removed")?.has("CONSTRAINTS.md")
    )
      flag(
        findings,
        "threshold-removed",
        file,
        "(enforced thresholds deleted with CONSTRAINTS.md)",
      );
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
  // Removed rows read the origin: a rename carries the destination as `file`
  // (the old path is only in `from`), so filtering on `file` would miss a
  // CONSTRAINTS.md moved to another name. Added rows stay on `file`, so a
  // move leaves the rows unpaired and they flag as threshold-removed unless
  // waived; findings name the origin so the waiver target is clear.
  const originOf = (l) => l.from ?? l.file;
  const removedRows = removed.filter(
    (l) => CONSTRAINTS_FILE.test(originOf(l)) && isEnforcedRow(l.text),
  );
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
    const origin = originOf(r);
    const sameLabel = addedByLabel.get(key);
    if (sameLabel) {
      if (isLowered(r.text, sameLabel.text))
        flag(findings, "threshold-lowered", origin, `${r.text}  ->  ${sameLabel.text}`);
      continue;
    }
    const sameCheck = addedByCheckedBy.get(checkedBy(r.text));
    if (sameCheck && !paired.has(sameCheck)) {
      paired.add(sameCheck);
      if (isLowered(r.text, sameCheck.text))
        flag(findings, "threshold-lowered", origin, `${r.text}  ->  ${sameCheck.text}`);
      continue;
    }
    if (waivers.get("threshold-removed")?.has(key)) continue;
    flag(findings, "threshold-removed", origin, r.text);
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
    ...scanAdded(added, opts.ignore ?? [], removed),
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
  // The working-tree ignore list comes from the checked-out repo (git top
  // level), not from this script's location: in CI they coincide, but reading
  // the script's own tree would miss the branch's ignore edits and break the
  // new-exemption waiver path under test.
  const repoRoot =
    git(["rev-parse", "--show-toplevel"])?.trim() ||
    resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
