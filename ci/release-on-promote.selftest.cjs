#!/usr/bin/env node
"use strict";

// Offline tests for release-on-promote.cjs: bump rules, note rendering, a dry
// run, and the publish path against a throwaway git repository with a fake gh
// on PATH (no network).

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = process.env.RELEASE_ON_PROMOTE || path.join(__dirname, "release-on-promote.cjs");
const REAL_CONFIG = path.join(__dirname, "..", "release-please-config.json");
const { parseCommit, nextVersion, renderNotes, loadOptions } = require(SCRIPT);
const { sections } = loadOptions(REAL_CONFIG);

const c = (subject, body = "") => parseCommit("a".repeat(40), subject, body);

// Parsing.
assert.deepEqual(c("feat(voice): add rooms (#12)"), {
  sha: "a".repeat(40),
  type: "feat",
  scope: "voice",
  breaking: false,
  desc: "add rooms",
  pr: 12,
});
assert.equal(c("fix!: drop legacy flag").breaking, true);
assert.equal(c("fix: x", "BREAKING CHANGE: removed y").breaking, true);
assert.equal(c("Merge branch main"), null);
assert.equal(c("feat(): empty scope"), null);

// Bumps (pre-1.0 with release-please's flags, then post-1.0).
const pre = { bumpMinorPreMajor: true, bumpPatchForMinorPreMajor: false };
assert.deepEqual(nextVersion([0, 4, 0], [c("fix: a")], pre), [0, 4, 1]);
assert.deepEqual(nextVersion([0, 4, 0], [c("fix: a"), c("feat: b")], pre), [0, 5, 0]);
assert.deepEqual(nextVersion([0, 4, 2], [c("feat!: b")], pre), [0, 5, 0]);
assert.deepEqual(nextVersion([0, 4, 2], [c("feat!: b")], { bumpMinorPreMajor: false }), [1, 0, 0]);
assert.deepEqual(
  nextVersion([0, 4, 2], [c("feat: b")], {
    bumpMinorPreMajor: true,
    bumpPatchForMinorPreMajor: true,
  }),
  [0, 4, 3],
);
assert.deepEqual(nextVersion([0, 4, 0], [c("chore: a")], pre), [0, 4, 1]);
assert.deepEqual(nextVersion([0, 4, 0], [], pre), [0, 4, 1]);
assert.deepEqual(nextVersion([1, 2, 3], [c("feat: a")], pre), [1, 3, 0]);
assert.deepEqual(nextVersion([1, 2, 3], [c("fix!: a")], pre), [2, 0, 0]);
assert.deepEqual(nextVersion([1, 2, 3], [c("perf: a")], pre), [1, 2, 4]);
assert.deepEqual(nextVersion([1, 2, 3], [c("security(auth): a")], pre), [1, 2, 4]);

// Notes: visible sections only, scope-sorted, hidden types dropped.
const notes = renderNotes({
  version: [0, 5, 0],
  prevTag: "v0.4.0",
  date: "2026-10-10",
  sections,
  repoUrl: "https://github.com/o/r",
  commits: [
    c("fix(b): second (#2)"),
    c("feat(z): last (#3)"),
    c("fix(a): first"),
    c("chore: hidden (#9)"),
    c("security: patch"),
  ],
});
assert.match(
  notes,
  /^## \[0\.5\.0\]\(https:\/\/github\.com\/o\/r\/compare\/v0\.4\.0\.\.\.v0\.5\.0\) \(2026-10-10\)/,
);
assert.ok(notes.indexOf("### Added") < notes.indexOf("### Fixed"));
assert.ok(notes.indexOf("**a:** first") < notes.indexOf("**b:** second"));
assert.ok(notes.includes("* patch ([aaaaaaa]"));
assert.ok(notes.includes("([#2](https://github.com/o/r/issues/2))"));
assert.ok(!notes.includes("hidden"));
assert.ok(!notes.includes("BREAKING"));
assert.match(
  renderNotes({
    version: [0, 4, 1],
    prevTag: "v0.4.0",
    date: "d",
    sections,
    repoUrl: "u",
    commits: [c("chore: x")],
  }),
  /No user-facing changes/,
);
const securityOnly = renderNotes({
  version: [0, 4, 1],
  prevTag: "v0.4.0",
  date: "d",
  sections,
  repoUrl: "https://github.com/o/r",
  commits: [c("security(auth): refuse expired sudo tokens (#900)")],
});
assert.ok(
  securityOnly.includes(
    "### Fixed\n\n* **auth:** refuse expired sudo tokens ([#900](https://github.com/o/r/issues/900))",
  ),
);
assert.doesNotMatch(securityOnly, /No user-facing/);
assert.match(
  renderNotes({
    version: [0, 5, 0],
    prevTag: "v0.4.0",
    date: "d",
    sections,
    repoUrl: "u",
    commits: [c("feat!: x")],
  }),
  /### ⚠ BREAKING CHANGES\n\n\* x/,
);

// Dry run on a real repository: version, rollback guard, off-main refusal.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-on-promote-"));
const g = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
g("init", "-q", "-b", "main");
g("config", "user.email", "t@example.invalid");
g("config", "user.name", "t");
const realPkg = JSON.parse(fs.readFileSync(REAL_CONFIG, "utf8")).packages["."];
delete realPkg["release-as"];
fs.writeFileSync(
  path.join(dir, "release-please-config.json"),
  JSON.stringify({ packages: { ".": realPkg } }),
);
const commit = (msg) => {
  g("commit", "-q", "--allow-empty", "-m", msg);
  return g("rev-parse", "HEAD");
};
g("add", ".");
const first = commit("chore(main): release 0.4.0 (#1)");
g("tag", "v0.4.0");
const fixSha = commit("fix(voice): retry renames (#2)");
const featSha = commit("feat(voice): name pools (#3)");
g("update-ref", "refs/remotes/origin/main", featSha);
g("checkout", "-q", "-b", "side", first);
const offMain = commit("feat: not on main");
g("checkout", "-q", "main");

const run = (sha) => {
  const out = path.join(dir, `out-${sha.slice(0, 7)}`);
  fs.writeFileSync(out, "");
  const res = require("node:child_process").spawnSync("node", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, RELEASE_SHA: sha, GH_REPO: "o/r", DRY_RUN: "true", GITHUB_OUTPUT: out },
  });
  return { ...res, out: fs.readFileSync(out, "utf8") };
};
let r = run(featSha);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /## \[0\.5\.0\]/);
assert.match(r.stdout, /### Added\n\n\* \*\*voice:\*\* name pools/);
assert.match(r.stdout, /### Fixed\n\n\* \*\*voice:\*\* retry renames/);
r = run(fixSha);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /## \[0\.4\.1\]/);
g("tag", "v0.5.0", featSha);
r = run(fixSha);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /rollback promote, no new tag/);
r = run(featSha);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /## \[0\.5\.0\]/, "an already tagged commit keeps its tag");
// release-as forces the cutover version while it is above the previous tag.
const config = path.join(dir, "release-please-config.json");
const base = JSON.parse(fs.readFileSync(config, "utf8"));
fs.writeFileSync(
  config,
  JSON.stringify({ packages: { ".": { ...base.packages["."], "release-as": "1.0.0" } } }),
);
// release-as never tags a commit older than the newest release (a rollback),
// even when release-as is above that release.
r = run(fixSha);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /older than v0\.5\.0; rollback promote, no new tag/);
g("tag", "-d", "v0.5.0");
r = run(featSha);
assert.equal(r.status, 0, r.stderr);
assert.match(
  r.stdout,
  /## \[1\.0\.0\]\(https:\/\/github\.com\/o\/r\/compare\/v0\.4\.0\.\.\.v1\.0\.0\)/,
);
g("tag", "v1.0.0", featSha);
r = run(fixSha);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /older than v1\.0\.0; rollback promote, no new tag/);
const later = commit("fix(voice): after cutover (#4)");
g("update-ref", "refs/remotes/origin/main", later);
r = run(later);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /## \[1\.0\.1\]/, "release-as is ignored once that version is tagged");
fs.writeFileSync(config, JSON.stringify(base));
r = run(offMain);
assert.notEqual(r.status, 0);
assert.match(r.stderr, /not on origin\/main/);
r = run("not-a-sha");
assert.notEqual(r.status, 0);

// Publishing against a fake gh that models the tag's release: absent, present,
// or a failed lookup. A failed lookup must stop before anything is created.
const ghBin = fs.mkdtempSync(path.join(os.tmpdir(), "release-gh-"));
fs.writeFileSync(
  path.join(ghBin, "gh"),
  [
    "#!/bin/sh",
    'echo "$*" >> "$FAKE_GH_LOG"',
    'case "$*" in',
    '  "api repos/o/r/releases/tags/v1.0.1"*)',
    '    case "$FAKE_GH_MODE" in',
    '      absent|create-fails) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
    '      exists) echo "{}"; exit 0 ;;',
    '      outage) echo "gh: Service Unavailable (HTTP 503)" >&2; exit 1 ;;',
    '      limited) echo "gh: API rate limit exceeded (HTTP 403)" >&2; exit 1 ;;',
    '      unauthorized) echo "gh: Bad credentials (HTTP 401)" >&2; exit 1 ;;',
    '      offline) echo "dial tcp: lookup api.github.com: no such host" >&2; exit 1 ;;',
    "      silent) exit 1 ;;",
    "    esac ;;",
    '  "release create "*)',
    '    case "$FAKE_GH_MODE" in',
    '      create-fails) echo "gh: release create failed (HTTP 500)" >&2; exit 1 ;;',
    "      *) exit 0 ;;",
    "    esac ;;",
    "esac",
    'echo "unexpected gh call: $*" >&2',
    "exit 2",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
const publish = (mode) => {
  const out = path.join(ghBin, `output-${mode}`);
  const log = path.join(ghBin, `gh-${mode}.log`);
  fs.writeFileSync(out, "");
  fs.writeFileSync(log, "");
  const res = require("node:child_process").spawnSync("node", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ghBin}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_MODE: mode,
      FAKE_GH_LOG: log,
      RELEASE_SHA: later,
      GH_REPO: "o/r",
      DRY_RUN: "false",
      GITHUB_OUTPUT: out,
      RUNNER_TEMP: ghBin,
    },
  });
  return { ...res, out: fs.readFileSync(out, "utf8"), gh: fs.readFileSync(log, "utf8") };
};
const absent = publish("absent");
assert.equal(absent.status, 0, absent.stderr);
assert.match(absent.gh, /^release create v1\.0\.1 /m);
assert.equal(absent.out, "tag_name=v1.0.1\nreleased=true\n");
const exists = publish("exists");
assert.equal(exists.status, 0, exists.stderr);
assert.doesNotMatch(exists.gh, /^release create /m);
assert.equal(exists.out, "tag_name=v1.0.1\nreleased=true\n");
for (const mode of ["outage", "limited", "unauthorized", "offline", "silent"]) {
  const stopped = publish(mode);
  assert.notEqual(stopped.status, 0, `${mode}: an inconclusive lookup must stop the promote`);
  assert.match(stopped.stderr, /existing-release lookup for v1\.0\.1 was inconclusive/, mode);
  assert.doesNotMatch(stopped.gh, /^release create /m, mode);
  assert.equal(stopped.out, "", mode);
}
// A failed `release create` must fail the promote without reporting a release,
// and retrying the exact promoted SHA must intend the same tag and target: no
// additional version bump. The fake create never writes a git tag, so the retry
// recomputes the version from the same history.
const failed = publish("create-fails");
assert.notEqual(failed.status, 0, "a failed release create must fail the promote");
assert.doesNotMatch(failed.stdout, /released=true/, "failed create must not report released=true");
assert.doesNotMatch(failed.out, /released=true/, "failed create must not report released=true");
assert.equal(failed.out, "", "failed create must leave GITHUB_OUTPUT empty");
assert.match(failed.gh, /^release create v1\.0\.1 /m, "failed create still attempted v1.0.1");
assert.match(
  failed.gh,
  new RegExp(`--target ${later}\\b`),
  "failed create targeted the promoted SHA",
);
const repair = publish("absent");
assert.equal(repair.status, 0, repair.stderr);
assert.equal(
  repair.out,
  "tag_name=v1.0.1\nreleased=true\n",
  "same-SHA retry repairs with the same tag",
);
assert.match(
  repair.gh,
  /^release create v1\.0\.1 /m,
  "repair still intends v1.0.1, no version bump",
);
assert.match(repair.gh, new RegExp(`--target ${later}\\b`), "repair targets the same promoted SHA");
assert.match(repair.stdout, /released=true/, "repair reports released=true");
assert.equal(g("tag", "--list", "v1.0.2"), "", "repair must not bump to v1.0.2");
// A tag present without its release repairs with that tag: reuse, same target,
// still no bump.
g("tag", "v1.0.1", later);
const tagged = publish("absent");
assert.equal(tagged.status, 0, tagged.stderr);
assert.equal(tagged.out, "tag_name=v1.0.1\nreleased=true\n", "present tag repairs with that tag");
assert.match(tagged.gh, /^release create v1\.0\.1 /m, "present tag reuses v1.0.1, no bump");
assert.match(tagged.gh, new RegExp(`--target ${later}\\b`), "present tag targets the promoted SHA");
assert.equal(g("tag", "--list", "v1.0.2"), "", "present-tag repair must not bump to v1.0.2");
g("tag", "-d", "v1.0.1");
// A range whose log is larger than Node's 1 MiB default buffer still renders.
const bodyFile = path.join(dir, "big-body.txt");
fs.writeFileSync(bodyFile, `fix(voice): long body (#5)\n\n${"x".repeat(2 * 1024 * 1024)}\n`);
g("commit", "-q", "--allow-empty", "-F", bodyFile);
const big = g("rev-parse", "HEAD");
g("update-ref", "refs/remotes/origin/main", big);
r = run(big);
assert.equal(r.status, 0, r.stderr);
assert.match(r.stdout, /long body/, "a range log over 1 MiB still renders its notes");
fs.rmSync(ghBin, { recursive: true, force: true });
fs.rmSync(dir, { recursive: true, force: true });

console.log("release-on-promote: all tests passed");
