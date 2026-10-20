#!/usr/bin/env node
"use strict";

// Acceptance contract for repairing a missing GitHub Release on a historical
// semver tag: the repair must publish at the exact existing tag/SHA and must
// explicitly request non-Latest semantics, so the repository's Latest pointer
// never moves backwards to an older version. A genuinely newest release keeps
// Latest semantics.
//
// Run: node ci/release-on-promote-latest.acceptance.cjs
// Set RELEASE_ON_PROMOTE to point at an alternate copy of the script under
// test (same seam as ci/release-on-promote.selftest.cjs). Offline throughout:
// a throwaway git repository and a fake `gh` on PATH; no network, no real
// release. The untagged newest publish is the only case that creates a tag,
// so only that child gets hermetic production proof: Actions API reads are
// forwarded to ci/release-promotion-proof.fixture.cjs, while release lookup
// and create stay in this file's fake `gh`. The candidate is not tagged
// ahead of the publisher. This file is the independent acceptance contract;
// wiring it into a suite (for example from test/release-workflow.test.ts)
// must not require editing it.

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fixture: promotionFixture } = require("./release-promotion-proof.fixture.cjs");

const SCRIPT = process.env.RELEASE_ON_PROMOTE || path.join(__dirname, "release-on-promote.cjs");
const REAL_CONFIG = path.join(__dirname, "..", "release-please-config.json");

// History: v0.8.0 -> fix -> feat tagged v0.9.0 (historical, Release missing)
// -> feat tagged v0.10.0 (newest tagged) -> fix (untagged newest candidate).
// v0.9.0 vs v0.10.0 is deliberate: a lexicographic version comparison would
// wrongly rank v0.9.0 above v0.10.0 and mark the historical repair Latest.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-latest-acceptance-"));
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
commit("chore(main): release 0.8.0 (#1)");
g("tag", "v0.8.0");
commit("fix(voice): retry renames (#2)");
const historical = commit("feat(voice): name pools (#3)");
g("tag", "v0.9.0", historical);
const newestTagged = commit("feat(voice): topic pools (#4)");
g("tag", "v0.10.0", newestTagged);
const newestUntagged = commit("fix(voice): after topics (#5)");
g("update-ref", "refs/remotes/origin/main", newestUntagged);

// Proof for the untagged newest publish only. Reuse the paired fixture's
// provider, then bind its receipt and producer metadata to this suite's
// candidate. Do not tag that commit here: a pre-existing tag would skip proof.
const promotion = promotionFixture({ after() {} });
promotion.state.receipt.sha = newestUntagged;
promotion.state.runs[0].head_sha = newestUntagged;
promotion.state.artifacts[0].workflow_run.head_sha = newestUntagged;
fs.writeFileSync(path.join(promotion.root, "provider.json"), JSON.stringify(promotion.state));

// Fake gh: records every argv line, models the release lookup per mode, and
// never creates a git tag or touches the network. Actions reads, and only
// those, are answered by the paired fixture.
const ghBin = fs.mkdtempSync(path.join(os.tmpdir(), "release-latest-gh-"));
fs.writeFileSync(
  path.join(ghBin, "gh"),
  [
    "#!/bin/sh",
    'echo "$*" >> "$FAKE_GH_LOG"',
    'case "$*" in',
    '  "api repos/o/r/releases/tags/"*)',
    '    case "$FAKE_GH_MODE" in',
    '      absent|create-fails) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
    '      exists) echo "{}"; exit 0 ;;',
    '      outage) echo "gh: Service Unavailable (HTTP 503)" >&2; exit 1 ;;',
    "    esac ;;",
    '  "release create "*)',
    '    case "$FAKE_GH_MODE" in',
    '      create-fails) echo "gh: release create failed (HTTP 500)" >&2; exit 1 ;;',
    "      *) exit 0 ;;",
    "    esac ;;",
    '  "api --method GET repos/o/r/actions/"*)',
    '    if [ -z "$PROOF_FIXTURE" ]; then echo "unexpected gh call: $*" >&2; exit 2; fi',
    `    exec "${process.execPath}" ${JSON.stringify(path.resolve(__dirname, "release-promotion-proof.fixture.cjs"))} --fake-gh "$@" ;;`,
    "esac",
    'echo "unexpected gh call: $*" >&2',
    "exit 2",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

let runCount = 0;
const run = ({ sha, mode = "absent", dryRun = false, promotionProof = false }) => {
  runCount += 1;
  const out = path.join(ghBin, `output-${runCount}`);
  const log = path.join(ghBin, `gh-${runCount}.log`);
  fs.writeFileSync(out, "");
  fs.writeFileSync(log, "");
  const res = spawnSync("node", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${ghBin}${path.delimiter}${process.env.PATH}`,
      FAKE_GH_MODE: mode,
      FAKE_GH_LOG: log,
      RELEASE_SHA: sha,
      GH_REPO: "o/r",
      DRY_RUN: dryRun ? "true" : "false",
      GITHUB_OUTPUT: out,
      RUNNER_TEMP: ghBin,
      ...(promotionProof
        ? {
            PROOF_FIXTURE: promotion.root,
            GITHUB_REPOSITORY: "o/r",
            GITHUB_REPOSITORY_ID: "100",
            PROMOTION_RUN_ID: "700",
            PROMOTION_RUN_ATTEMPT: "2",
          }
        : {}),
    },
  });
  return { ...res, out: fs.readFileSync(out, "utf8"), gh: fs.readFileSync(log, "utf8") };
};

// The single `release create` line for a tag, split into argv tokens.
const createTokens = (ghLog, tag) => {
  const lines = ghLog.split("\n").filter((l) => l.startsWith(`release create ${tag} `));
  assert.equal(
    lines.length,
    1,
    `expected exactly one release create for ${tag}, gh log:\n${ghLog}`,
  );
  return lines[0].split(" ").filter(Boolean);
};
const latestTokens = (tokens) =>
  tokens.filter((t) => t === "--latest" || t.startsWith("--latest="));
const assertNonLatest = (tokens, tag) => {
  assert.deepEqual(
    latestTokens(tokens),
    ["--latest=false"],
    `${tag}: historical repair must explicitly request non-Latest (--latest=false), got: ${tokens.join(" ")}`,
  );
};
const assertLatest = (tokens, tag) => {
  const found = latestTokens(tokens);
  assert.equal(
    found.length,
    1,
    `${tag}: newest release must request Latest exactly once, got: ${tokens.join(" ")}`,
  );
  assert.ok(
    found[0] === "--latest" || found[0] === "--latest=true",
    `${tag}: newest release must retain Latest semantics, got: ${found[0]}`,
  );
};
const assertTarget = (tokens, sha, tag) => {
  const i = tokens.indexOf("--target");
  assert.ok(
    i >= 0 && tokens[i + 1] === sha,
    `${tag}: create must target ${sha}, got: ${tokens.join(" ")}`,
  );
};

// 1. Historical repair: a missing Release on v0.9.0 is created at the exact
// tag/SHA, explicitly non-Latest, without moving or adding any tag.
const repair = run({ sha: historical });
assert.equal(repair.status, 0, repair.stderr);
assert.equal(
  repair.out,
  "tag_name=v0.9.0\nreleased=true\n",
  "historical repair reports its own tag",
);
assert.match(repair.gh, /^api repos\/o\/r\/releases\/tags\/v0\.9\.0$/m, "lookup probes v0.9.0");
const repairTokens = createTokens(repair.gh, "v0.9.0");
assertTarget(repairTokens, historical, "v0.9.0");
assertNonLatest(repairTokens, "v0.9.0");
assert.equal(
  g("rev-parse", "v0.9.0^{commit}"),
  historical,
  "repair must not move the existing v0.9.0 tag",
);
assert.equal(g("tag", "--list", "v0.9.1"), "", "repair must not bump to a new version");

// 1b. Same-SHA repair is repeatable: a second run at the same SHA still
// intends v0.9.0 at the same target with non-Latest semantics.
const repairAgain = run({ sha: historical });
assert.equal(repairAgain.status, 0, repairAgain.stderr);
assert.equal(repairAgain.out, "tag_name=v0.9.0\nreleased=true\n", "same-SHA retry keeps v0.9.0");
const repairAgainTokens = createTokens(repairAgain.gh, "v0.9.0");
assertTarget(repairAgainTokens, historical, "v0.9.0");
assertNonLatest(repairAgainTokens, "v0.9.0");

// 2. Positive control: repairing the genuinely newest tagged release
// (v0.10.0) retains Latest semantics.
const newestRepair = run({ sha: newestTagged });
assert.equal(newestRepair.status, 0, newestRepair.stderr);
assert.equal(newestRepair.out, "tag_name=v0.10.0\nreleased=true\n");
const newestTokens = createTokens(newestRepair.gh, "v0.10.0");
assertTarget(newestTokens, newestTagged, "v0.10.0");
assertLatest(newestTokens, "v0.10.0");

// 3. Positive control: publishing a genuinely newest untagged commit keeps
// Latest semantics for the computed next version.
const newestPublish = run({ sha: newestUntagged, promotionProof: true });
assert.equal(newestPublish.status, 0, newestPublish.stderr);
assert.equal(newestPublish.out, "tag_name=v0.10.1\nreleased=true\n");
const publishTokens = createTokens(newestPublish.gh, "v0.10.1");
assertTarget(publishTokens, newestUntagged, "v0.10.1");
assertLatest(publishTokens, "v0.10.1");

// 4. Control: an existing historical Release is a no-op (no create at all).
const exists = run({ sha: historical, mode: "exists" });
assert.equal(exists.status, 0, exists.stderr);
assert.equal(exists.out, "tag_name=v0.9.0\nreleased=true\n");
assert.doesNotMatch(exists.gh, /^release create /m, "existing release must not be recreated");

// 5. Control: dry-run at the historical SHA publishes nothing and calls no gh.
const dry = run({ sha: historical, dryRun: true });
assert.equal(dry.status, 0, dry.stderr);
assert.equal(dry.out, "tag_name=\nreleased=false\n");
assert.equal(dry.gh, "", "dry-run must not call gh");

// 6. Control: an inconclusive lookup (503, not a 404) refuses to publish the
// historical repair rather than falling through to create.
const outage = run({ sha: historical, mode: "outage" });
assert.notEqual(outage.status, 0, "inconclusive lookup must fail the promote");
assert.match(outage.stderr, /existing-release lookup for v0\.9\.0 was inconclusive/);
assert.doesNotMatch(outage.gh, /^release create /m);
assert.equal(outage.out, "", "inconclusive lookup must leave GITHUB_OUTPUT empty");

// 7. Control: a failed historical `release create` propagates as a failure
// and never reports released=true.
const failed = run({ sha: historical, mode: "create-fails" });
assert.notEqual(failed.status, 0, "failed create must fail the promote");
assert.equal(failed.out, "", "failed create must leave GITHUB_OUTPUT empty");
assert.doesNotMatch(failed.stdout, /released=true/);
const failedTokens = createTokens(failed.gh, "v0.9.0");
assertTarget(failedTokens, historical, "v0.9.0");

fs.rmSync(ghBin, { recursive: true, force: true });
fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(promotion.root, { recursive: true, force: true });

console.log("release-on-promote latest acceptance: all tests passed");
