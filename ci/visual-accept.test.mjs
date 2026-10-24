import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { acceptBaselines } from "./visual-accept.mjs";
import { acceptBaselines as acceptKitBaselines } from "./kit-visual-accept.mjs";

const SCRIPT = new URL("./visual-accept.mjs", import.meta.url);

function scratchRoot(prefix) {
  return mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      prefix,
    ),
  );
}

function writeBytes(path, text) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function listFilesRecursive(dir) {
  const out = [];
  const walk = (current, relative) => {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of [...entries].sort()) {
      const full = join(current, entry);
      const rel = relative ? `${relative}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

// Runs the CLI with cwd set to a scratch workspace so the relative
// e2e/visual/__screenshots__ destination stays inside scratch. Returns the
// spawn result plus the scratch destination directory path.
function runAccept(workspace, artifactDir) {
  const result = spawnSync(process.execPath, [SCRIPT.pathname, artifactDir], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: workspace,
  });
  assert.equal(result.error, undefined);
  return { result, destDir: join(workspace, "e2e", "visual", "__screenshots__") };
}

test("duplicate actual baselines for one destination are refused before any write", () => {
  const workspace = scratchRoot("visual-accept-collision-");
  const artifact = join(workspace, "artifact");
  // Two admitted candidates in different subtrees flatten to the same name.
  writeBytes(join(artifact, "test-results-visual", "a", "home-actual.png"), "candidate-a-bytes");
  writeBytes(join(artifact, "test-results-visual", "b", "home-actual.png"), "candidate-b-bytes");
  // A pre-existing baseline that must survive the refusal byte-for-byte.
  writeBytes(join(workspace, "e2e", "visual", "__screenshots__", "home.png"), "baseline-bytes");
  writeBytes(join(workspace, "e2e", "visual", "__screenshots__", "other.png"), "other-bytes");
  const before = listFilesRecursive(join(workspace, "e2e", "visual", "__screenshots__"));

  const { result, destDir } = runAccept(workspace, artifact);

  assert.notEqual(result.status, 0, `expected refusal, stdout: ${result.stdout}`);
  assert.match(result.stderr, /home\.png/, "diagnostic must name the colliding destination");
  assert.equal(readFileSync(join(destDir, "home.png"), "utf8"), "baseline-bytes");
  assert.equal(readFileSync(join(destDir, "other.png"), "utf8"), "other-bytes");
  assert.deepEqual(listFilesRecursive(destDir), before);
});

test("a reviewed actual supersedes a stale committed copy of the same destination", () => {
  const workspace = scratchRoot("visual-accept-precedence-");
  const artifact = join(workspace, "artifact");
  // The failure artifact carries the whole __screenshots__ dir (stale committed
  // copies) next to the reviewed actuals; the actual must win, not refuse.
  writeBytes(join(artifact, "test-results-visual", "run", "home-actual.png"), "actual-bytes");
  writeBytes(
    join(artifact, "run", "e2e", "visual", "__screenshots__", "home.png"),
    "stale-baseline-bytes",
  );
  writeBytes(join(artifact, "test-results-visual", "run", "about-actual.png"), "about-bytes");
  writeBytes(join(workspace, "e2e", "visual", "__screenshots__", "home.png"), "baseline-bytes");
  const before = listFilesRecursive(join(workspace, "e2e", "visual", "__screenshots__"));

  const { result, destDir } = runAccept(workspace, artifact);

  assert.equal(result.status, 0, `expected acceptance, stderr: ${result.stderr}`);
  assert.match(result.stdout, /accepted 2 baseline\(s\)/);
  assert.match(result.stdout, /dropped 1 stale/);
  assert.equal(readFileSync(join(destDir, "home.png"), "utf8"), "actual-bytes");
  assert.equal(readFileSync(join(destDir, "about.png"), "utf8"), "about-bytes");
  assert.deepEqual(
    listFilesRecursive(destDir).filter((f) => !before.includes(f)),
    ["about.png"],
  );
});

test("a changed page next to a full committed screenshots dir is accepted", () => {
  const workspace = scratchRoot("visual-accept-real-layout-");
  const artifact = join(workspace, "artifact");
  // Real e2e-failure artifact layout: every committed baseline is present
  // under e2e/visual/__screenshots__/, plus the reviewed actual rendering.
  writeBytes(join(artifact, "e2e", "visual", "__screenshots__", "home-desktop.png"), "committed");
  writeBytes(join(artifact, "e2e", "visual", "__screenshots__", "about.png"), "committed-about");
  writeBytes(
    join(artifact, "test-results-visual", "home", "home-desktop-actual.png"),
    "new-rendering",
  );
  writeBytes(join(workspace, "e2e", "visual", "__screenshots__", "home-desktop.png"), "committed");
  writeBytes(join(workspace, "e2e", "visual", "__screenshots__", "about.png"), "committed-about");

  const { result, destDir } = runAccept(workspace, artifact);

  assert.equal(result.status, 0, `expected acceptance, stderr: ${result.stderr}`);
  assert.match(result.stdout, /accepted 1 baseline\(s\)/);
  assert.equal(readFileSync(join(destDir, "home-desktop.png"), "utf8"), "new-rendering");
  assert.equal(readFileSync(join(destDir, "about.png"), "utf8"), "committed-about");
});

test("byte-identical duplicate actuals are accepted once, not refused", () => {
  const workspace = scratchRoot("visual-accept-identical-");
  const artifact = join(workspace, "artifact");
  writeBytes(join(artifact, "test-results-visual", "a", "home-actual.png"), "same-bytes");
  writeBytes(join(artifact, "test-results-visual", "b", "home-actual.png"), "same-bytes");

  const { result, destDir } = runAccept(workspace, artifact);

  assert.equal(result.status, 0, `expected acceptance, stderr: ${result.stderr}`);
  assert.match(result.stdout, /accepted 1 baseline\(s\)/);
  assert.equal(readFileSync(join(destDir, "home.png"), "utf8"), "same-bytes");
});

test("differing duplicate new baselines are refused without partial writes", () => {
  const workspace = scratchRoot("visual-accept-snapshot-dup-");
  const artifact = join(workspace, "artifact");
  writeBytes(join(artifact, "a", "e2e", "visual", "__screenshots__", "about.png"), "variant-a");
  writeBytes(join(artifact, "b", "e2e", "visual", "__screenshots__", "about.png"), "variant-b");

  const { result } = runAccept(workspace, artifact);

  assert.notEqual(result.status, 0, `expected refusal, stdout: ${result.stdout}`);
  assert.match(result.stderr, /about\.png/);
  assert.throws(() => statSync(join(workspace, "e2e", "visual", "__screenshots__")));
});

test("collision refusal does not create the destination directory", () => {
  const workspace = scratchRoot("visual-accept-nodest-");
  const artifact = join(workspace, "artifact");
  writeBytes(join(artifact, "test-results-visual", "a", "home-actual.png"), "candidate-a-bytes");
  writeBytes(join(artifact, "test-results-visual", "b", "home-actual.png"), "candidate-b-bytes");

  const { result } = runAccept(workspace, artifact);

  assert.notEqual(result.status, 0, `expected refusal, stdout: ${result.stdout}`);
  assert.match(result.stderr, /home\.png/);
  assert.throws(() => statSync(join(workspace, "e2e", "visual", "__screenshots__")));
});

test("non-colliding actual and new baselines are still accepted", () => {
  const workspace = scratchRoot("visual-accept-ok-");
  const artifact = join(workspace, "artifact");
  writeBytes(join(artifact, "test-results-visual", "run", "home-actual.png"), "home-bytes");
  writeBytes(join(artifact, "run", "e2e", "visual", "__screenshots__", "about.png"), "about-bytes");

  const { result, destDir } = runAccept(workspace, artifact);

  assert.equal(result.status, 0, `expected acceptance, stderr: ${result.stderr}`);
  assert.match(result.stdout, /accepted 2 baseline\(s\)/);
  assert.equal(readFileSync(join(destDir, "home.png"), "utf8"), "home-bytes");
  assert.equal(readFileSync(join(destDir, "about.png"), "utf8"), "about-bytes");
});

test("Kit suite outputs in the shared artifact are ignored", () => {
  const workspace = scratchRoot("visual-accept-kit-ignored-");
  const artifact = join(workspace, "artifact");
  // Shared e2e-failure artifact layout: Kit actuals and Kit new baselines
  // must never regenerate a Hono baseline.
  writeBytes(
    join(artifact, "test-results-kit-parity", "past", "past-desktop-actual.png"),
    "kit-parity-bytes",
  );
  writeBytes(
    join(artifact, "test-results-kit-visual", "past", "past-desktop-actual.png"),
    "kit-visual-bytes",
  );
  writeBytes(
    join(artifact, "e2e", "visual", "__screenshots-kit__", "past-desktop.png"),
    "kit-new-baseline",
  );
  writeBytes(join(artifact, "test-results-visual", "home", "home-actual.png"), "hono-bytes");

  const { result, destDir } = runAccept(workspace, artifact);

  assert.equal(result.status, 0, `expected acceptance, stderr: ${result.stderr}`);
  assert.match(result.stdout, /accepted 1 baseline\(s\)/);
  assert.equal(readFileSync(join(destDir, "home.png"), "utf8"), "hono-bytes");
  assert.deepEqual(listFilesRecursive(destDir), ["home.png"]);
});

test("acceptBaselines reports counts and throws a diagnostic on collision", () => {
  const root = scratchRoot("visual-accept-api-");
  const artifact = join(root, "artifact");
  const destDir = join(root, "dest");
  writeBytes(join(artifact, "test-results-visual", "run", "home-actual.png"), "actual-bytes");
  writeBytes(join(artifact, "run", "e2e", "visual", "__screenshots__", "home.png"), "stale-bytes");

  const { written, dropped } = acceptBaselines(artifact, destDir);

  assert.equal(written, 1);
  assert.equal(dropped, 1);
  assert.equal(readFileSync(join(destDir, "home.png"), "utf8"), "actual-bytes");

  writeBytes(join(artifact, "test-results-visual", "other", "home-actual.png"), "different-bytes");
  assert.throws(() => acceptBaselines(artifact, join(root, "dest2")), /home\.png/);
});

// Shared behavioral contract: an artifact copy is not a reviewed replacement,
// and only suite segments *inside* the artifact establish image ownership.
// Keep this matrix in the already CI-routed suite; neither helper is mocked.
const ACCEPTANCE_SUITES = [
  {
    name: "Hono",
    script: SCRIPT,
    snapshots: "e2e/visual/__screenshots__",
    otherSnapshots: "e2e/visual/__screenshots-kit__",
    actuals: "test-results-visual",
    accept: (artifact, workspace) => {
      acceptBaselines(artifact, join(workspace, "e2e/visual/__screenshots__"));
      return { ok: true };
    },
    mixedExpected: { "hono-home.png": "hono-home", "new-hono.png": "new-hono" },
  },
  {
    name: "Kit",
    script: new URL("./kit-visual-accept.mjs", import.meta.url),
    snapshots: "e2e/visual/__screenshots-kit__",
    otherSnapshots: "e2e/visual/__screenshots__",
    actuals: "test-results-kit-visual",
    accept: (artifact, workspace) => acceptKitBaselines(artifact, { cwd: workspace }),
    mixedExpected: {
      "kit-events.png": "kit-events",
      "kit-past.png": "kit-past",
      "new-kit.png": "new-kit",
    },
  },
];

function acceptanceFixture(t, suite, artifactName = "artifact") {
  const root = scratchRoot("baseline-contract-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "checkout");
  const artifact = join(root, artifactName);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(artifact, { recursive: true });
  return {
    workspace,
    artifact,
    dest: join(workspace, suite.snapshots),
    otherDest: join(workspace, suite.otherSnapshots),
  };
}

function baselineBytes(dir) {
  return Object.fromEntries(
    listFilesRecursive(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}

function attemptAcceptance(suite, artifact, workspace) {
  try {
    return suite.accept(artifact, workspace);
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

function writeMixedArtifact(artifact) {
  writeBytes(join(artifact, "test-results-visual/home/hono-home-actual.png"), "hono-home");
  writeBytes(join(artifact, "test-results-kit-visual/events/kit-events-actual.png"), "kit-events");
  writeBytes(join(artifact, "test-results-kit-parity/past/kit-past-actual.png"), "kit-past");
  writeBytes(join(artifact, "e2e/visual/__screenshots__/new-hono.png"), "new-hono");
  writeBytes(join(artifact, "e2e/visual/__screenshots-kit__/new-kit.png"), "new-kit");
  writeBytes(join(artifact, "test-results-visual/home/hono-home-expected.png"), "not-reviewed");
  writeBytes(join(artifact, "test-results-kit-visual/events/kit-events-diff.png"), "not-reviewed");
}

// Permission bits do not make files unreadable when CI runs as root. Inject
// EACCES at the real fs read/copy boundary in a child; retain real discovery,
// planning and writes, so a write-before-read regression leaves visible bytes.
const UNREADABLE_CANDIDATE_RUNNER = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const [script, suite, artifact, workspace, unreadable] = process.argv.slice(1);
for (const method of ["readFileSync", "copyFileSync"]) {
  const original = fs[method];
  fs[method] = function (path, ...args) {
    if (String(path) === unreadable) {
      const error = new Error("EACCES: unreadable candidate " + path);
      error.code = "EACCES";
      throw error;
    }
    return original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
const { acceptBaselines } = await import(script);
try {
  const result = suite === "Kit"
    ? acceptBaselines(artifact, { cwd: workspace })
    : acceptBaselines(artifact, join(workspace, "e2e/visual/__screenshots__"));
  if (result.ok === false) {
    console.error(result.message);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
`;

for (const suite of ACCEPTANCE_SUITES) {
  test(`${suite.name}: an unrelated newer checkout baseline is never reverted by an artifact copy`, (t) => {
    const { workspace, artifact, dest } = acceptanceFixture(t, suite);
    writeBytes(join(dest, "a-page.png"), "checkout-page");
    writeBytes(join(dest, "z-unrelated.png"), "newer-checkout-unrelated");
    writeBytes(join(artifact, suite.actuals, "a-page-actual.png"), "reviewed-page");
    writeBytes(join(artifact, suite.snapshots, "z-unrelated.png"), "older-artifact-unrelated");
    writeBytes(join(artifact, suite.snapshots, "b-new.png"), "new-baseline");
    const before = baselineBytes(dest);

    const result = attemptAcceptance(suite, artifact, workspace);

    if (result.ok) {
      assert.deepEqual(
        baselineBytes(dest),
        {
          "a-page.png": "reviewed-page",
          "b-new.png": "new-baseline",
          "z-unrelated.png": "newer-checkout-unrelated",
        },
        "accepting a reviewed page must preserve a newer unrelated checkout baseline",
      );
    } else {
      assert.match(
        result.message,
        /z-unrelated\.png/,
        "preflight conflict must identify the unrelated destination",
      );
      assert.match(result.message, /conflict|refus|differ|stale|overwrite/i);
      assert.deepEqual(
        baselineBytes(dest),
        before,
        "a stale-copy conflict must abort the entire plan",
      );
    }
  });

  test(`${suite.name}: identical artifact copies are no-ops while absent baselines are added`, (t) => {
    const { workspace, artifact, dest } = acceptanceFixture(t, suite);
    const unchanged = join(dest, "unchanged.png");
    writeBytes(unchanged, "unchanged-bytes");
    utimesSync(unchanged, 946684800, 946684800);
    const before = statSync(unchanged).mtimeMs;
    writeBytes(join(artifact, suite.snapshots, "unchanged.png"), "unchanged-bytes");
    writeBytes(join(artifact, suite.snapshots, "new.png"), "new-bytes");
    writeBytes(join(artifact, suite.actuals, "page-actual.png"), "reviewed-bytes");

    const result = attemptAcceptance(suite, artifact, workspace);

    assert.equal(result.ok, true, result.message);
    assert.deepEqual(baselineBytes(dest), {
      "new.png": "new-bytes",
      "page.png": "reviewed-bytes",
      "unchanged.png": "unchanged-bytes",
    });
    assert.equal(
      statSync(unchanged).mtimeMs,
      before,
      "an identical artifact copy must not rewrite the local file",
    );
  });

  test(`${suite.name}: reviewed actuals replace checkout bytes and outrank stale copies`, (t) => {
    const { workspace, artifact, dest } = acceptanceFixture(t, suite);
    writeBytes(join(dest, "page.png"), "newer-checkout-page");
    writeBytes(join(artifact, suite.snapshots, "page.png"), "older-artifact-page");
    writeBytes(join(artifact, suite.actuals, "a/page-actual.png"), "reviewed-page");
    writeBytes(join(artifact, suite.actuals, "b/page-actual.png"), "reviewed-page");

    const result = attemptAcceptance(suite, artifact, workspace);

    assert.equal(result.ok, true, result.message);
    assert.deepEqual(baselineBytes(dest), { "page.png": "reviewed-page" });
  });

  test(`${suite.name}: actual-looking files in baseline dirs remain copies`, (t) => {
    const absent = acceptanceFixture(t, suite);
    writeBytes(join(absent.artifact, suite.snapshots, "page-actual.png"), "copy-bytes");

    const absentResult = attemptAcceptance(suite, absent.artifact, absent.workspace);

    assert.equal(absentResult.ok, true, absentResult.message);
    assert.deepEqual(baselineBytes(absent.dest), { "page-actual.png": "copy-bytes" });
    assert.equal(
      baselineBytes(absent.dest)["page.png"],
      undefined,
      "a baseline-directory filename must not grant reviewed-actual authority",
    );

    const differing = acceptanceFixture(t, suite);
    writeBytes(join(differing.dest, "page-actual.png"), "checkout-bytes");
    writeBytes(join(differing.artifact, suite.snapshots, "page-actual.png"), "copy-bytes");
    writeBytes(join(differing.artifact, suite.actuals, "other-actual.png"), "reviewed-other");
    const before = baselineBytes(differing.dest);

    const differingResult = attemptAcceptance(suite, differing.artifact, differing.workspace);

    assert.equal(differingResult.ok, false, "a differing checkout target must be refused");
    assert.match(differingResult.message, /page-actual\.png/);
    assert.deepEqual(
      baselineBytes(differing.dest),
      before,
      "the stale-copy refusal must not apply the unrelated reviewed actual",
    );
  });

  test(`${suite.name}: conflicting actuals abort unrelated additions and replacements`, (t) => {
    const { workspace, artifact, dest } = acceptanceFixture(t, suite);
    writeBytes(join(dest, "a-replace.png"), "checkout-page");
    writeBytes(join(dest, "sentinel.png"), "untouched");
    writeBytes(join(artifact, suite.actuals, "a/a-replace-actual.png"), "reviewed-page");
    writeBytes(join(artifact, suite.snapshots, "b-new.png"), "new-baseline");
    writeBytes(join(artifact, suite.actuals, "y/z-conflict-actual.png"), "candidate-one");
    writeBytes(join(artifact, suite.actuals, "z/z-conflict-actual.png"), "candidate-two");
    const before = baselineBytes(dest);

    const result = attemptAcceptance(suite, artifact, workspace);

    assert.equal(result.ok, false, "different actuals for one destination must be refused");
    assert.match(result.message, /z-conflict\.png/);
    assert.deepEqual(baselineBytes(dest), before);
  });

  for (const artifactName of [
    "artifact",
    "test-results-kit-visual",
    "test-results-kit-parity",
    "__screenshots-kit__",
    "export-test-results-kit-visual-backup",
  ]) {
    test(`${suite.name}: mixed suite plan is correct under extraction root ${artifactName}`, (t) => {
      const { workspace, artifact, dest, otherDest } = acceptanceFixture(t, suite, artifactName);
      writeMixedArtifact(artifact);
      writeBytes(join(otherDest, "sentinel.png"), "other-suite-untouched");

      const result = attemptAcceptance(suite, artifact, workspace);

      assert.equal(result.ok, true, result.message);
      assert.deepEqual(baselineBytes(dest), suite.mixedExpected);
      assert.deepEqual(baselineBytes(otherDest), { "sentinel.png": "other-suite-untouched" });
    });
  }

  for (const wrapper of [
    "test-results-kit-visual-backup",
    "prefix-test-results-kit-parity",
    "__screenshots-kit__-backup",
  ]) {
    test(`${suite.name}: lookalike wrapper ${wrapper} does not classify nested suite paths`, (t) => {
      const { workspace, artifact, dest } = acceptanceFixture(t, suite);
      writeMixedArtifact(join(artifact, wrapper));

      const result = attemptAcceptance(suite, artifact, workspace);

      assert.equal(result.ok, true, result.message);
      assert.deepEqual(baselineBytes(dest), suite.mixedExpected);
    });
  }

  for (const kind of ["actual", "baseline copy"]) {
    test(`${suite.name}: an unreadable ${kind} aborts before any other write`, (t) => {
      const { workspace, artifact, dest } = acceptanceFixture(t, suite);
      writeBytes(join(dest, "a-replace.png"), "checkout-page");
      writeBytes(join(dest, "sentinel.png"), "untouched");
      writeBytes(join(artifact, suite.actuals, "a/a-replace-actual.png"), "reviewed-page");
      writeBytes(join(artifact, suite.actuals, "b/b-new-actual.png"), "new-baseline");
      const unreadable =
        kind === "actual"
          ? join(artifact, suite.actuals, "z/z-unreadable-actual.png")
          : join(artifact, suite.snapshots, "z-unreadable.png");
      writeBytes(unreadable, "cannot-read-these-bytes");
      const before = baselineBytes(dest);

      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          UNREADABLE_CANDIDATE_RUNNER,
          suite.script.href,
          suite.name,
          artifact,
          workspace,
          unreadable,
        ],
        { encoding: "utf8", timeout: 30_000, cwd: workspace },
      );

      assert.equal(result.error, undefined);
      assert.notEqual(
        result.status,
        0,
        "unreadable candidates must refuse rather than silently disappear",
      );
      assert.match(result.stderr, /EACCES|unreadable/i);
      assert.match(result.stderr, /z-unreadable/);
      assert.deepEqual(
        baselineBytes(dest),
        before,
        "source-read failure must not partially apply the plan",
      );
    });
  }
}

test("Kit: lookalike-only suite directories do not admit Hono actuals", (t) => {
  const suite = ACCEPTANCE_SUITES[1];
  const { workspace, artifact, dest } = acceptanceFixture(t, suite);
  for (const lookalike of [
    "test-results-kit-visual-backup",
    "prefix-test-results-kit-parity",
    "__screenshots-kit__-backup",
  ]) {
    writeBytes(join(artifact, lookalike, "test-results-visual/home-actual.png"), "hono-not-kit");
  }
  writeBytes(join(artifact, suite.actuals, "kit-actual.png"), "reviewed-kit");

  const result = attemptAcceptance(suite, artifact, workspace);

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(baselineBytes(dest), { "kit.png": "reviewed-kit" });
});

// Independent boundary handoff. Only synthetic bytes in run-owned trees; no
// image baselines, browser, database or downloaded artifact is involved.
// The CLI v1 contract uses { version, suite, items, errors, next_action }.
// IDs are opaque but stable across extraction roots, discovery order and mode.
const BOUNDARY_SUITES = ACCEPTANCE_SUITES.map((suite) => ({
  ...suite,
  id: suite.name.toLowerCase(),
}));

function boundaryFixture(t, suite) {
  const root = scratchRoot("artifact-boundary-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "checkout");
  const artifact = join(root, "artifact");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(artifact);
  writeBytes(join(outside, "canary.png"), "outside-canary");
  return { root, workspace, artifact, outside, dest: join(workspace, suite.snapshots) };
}

// Never follow links while observing the fixture. Include directories and file
// mtimes so a failed preflight cannot hide mkdir or identical-byte rewrites.
function boundaryTree(root) {
  const rows = [];
  function walk(path, relative) {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) rows.push([relative, "link", readlinkSync(path)]);
    else if (st.isDirectory()) {
      rows.push([relative, "dir"]);
      for (const name of readdirSync(path).sort()) walk(join(path, name), `${relative}/${name}`);
    } else rows.push([relative, "file", readFileSync(path).toString("hex"), st.mtimeMs]);
  }
  walk(root, ".");
  return rows;
}

function boundaryCli(suite, f, flags = [], artifact = f.artifact) {
  const result = spawnSync(process.execPath, [suite.script.pathname, artifact, ...flags], {
    cwd: f.workspace,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 128 * 1024,
  });
  assert.equal(result.error, undefined, "CLI must settle without a timeout or spawn error");
  assert.equal(result.signal, null);
  return result;
}

function boundaryJson(suite, result) {
  let report;
  assert.doesNotThrow(() => {
    report = JSON.parse(result.stdout);
  }, "--format json must emit one JSON document on stdout");
  assert.equal(report.version, 1);
  assert.equal(report.suite, suite.id);
  assert.ok(Array.isArray(report.items));
  assert.ok(Array.isArray(report.errors));
  assert.equal(typeof report.next_action, "string");
  assert.ok(report.next_action.length > 0 && report.next_action.length <= 256);
  assert.equal(result.stderr, "", "machine output must not mix prose or raw filesystem errors");
  function safeStrings(value) {
    if (typeof value === "string") assert.doesNotMatch(value, /[\x00-\x1f\x7f]/);
    else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) safeStrings(nested);
    }
  }
  safeStrings(report);
  const ids = report.items.map((item) => item.id);
  for (const id of ids) {
    assert.equal(typeof id, "string");
    assert.match(id, /^[a-zA-Z0-9_.:-]{1,160}$/);
  }
  assert.equal(new Set(ids).size, ids.length, "each effective plan item needs its own ID");
  return report;
}

const LINK_CASES = [
  [
    "source file",
    "SOURCE_SYMLINK",
    (f, s) => {
      symlinkSync(join(f.outside, "canary.png"), join(f.artifact, s.actuals, "z-link-actual.png"));
    },
  ],
  [
    "source directory",
    "SOURCE_SYMLINK",
    (f, s) => {
      writeBytes(join(f.outside, "z-link-actual.png"), "outside-source");
      symlinkSync(f.outside, join(f.artifact, s.actuals, "z-linked"), "dir");
    },
  ],
  [
    "source cycle",
    "SOURCE_SYMLINK",
    (f, s) => {
      symlinkSync(f.artifact, join(f.artifact, s.actuals, "z-cycle"), "dir");
    },
  ],
  [
    "source root",
    "SOURCE_SYMLINK",
    (f) => {
      const alias = join(f.root, "artifact-alias");
      symlinkSync(f.artifact, alias, "dir");
      f.artifact = alias;
    },
  ],
  [
    "source root ancestor",
    "SOURCE_SYMLINK",
    (f) => {
      const alias = join(f.root, "source-parent-alias");
      symlinkSync(f.root, alias, "dir");
      f.artifact = join(alias, "artifact");
    },
  ],
  [
    "destination file",
    "DESTINATION_SYMLINK",
    (f) => {
      mkdirSync(f.dest, { recursive: true });
      symlinkSync(join(f.outside, "canary.png"), join(f.dest, "a-page.png"));
    },
  ],
  [
    "dangling destination file",
    "DESTINATION_SYMLINK",
    (f) => {
      mkdirSync(f.dest, { recursive: true });
      symlinkSync(join(f.outside, "missing.png"), join(f.dest, "a-page.png"));
    },
  ],
  [
    "destination root",
    "DESTINATION_SYMLINK",
    (f) => {
      mkdirSync(join(f.dest, ".."), { recursive: true });
      symlinkSync(f.outside, f.dest, "dir");
    },
  ],
  [
    "destination ancestor",
    "DESTINATION_SYMLINK",
    (f) => {
      symlinkSync(f.outside, join(f.workspace, "e2e"), "dir");
    },
  ],
  [
    "destination ancestor cycle",
    "DESTINATION_SYMLINK",
    (f) => {
      symlinkSync("e2e", join(f.workspace, "e2e"), "dir");
    },
  ],
];

for (const suite of BOUNDARY_SUITES) {
  test(`${suite.name} boundary CONTROL: default accepts real suite actuals and baseline additions`, (t) => {
    const f = boundaryFixture(t, suite);
    writeBytes(join(f.artifact, suite.actuals, "a-page-actual.png"), "reviewed");
    writeBytes(join(f.artifact, suite.snapshots, "new.png"), "new-copy");
    writeBytes(join(f.dest, "a-page.png"), "checkout");
    const outside = boundaryTree(f.outside);
    const result = boundaryCli(suite, f);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(baselineBytes(f.dest), { "a-page.png": "reviewed", "new.png": "new-copy" });
    assert.deepEqual(boundaryTree(f.outside), outside);
  });

  for (const foreign of [
    "test-results-staging",
    "test-results-visual-backup",
    "prefix-test-results-visual",
    "test-results-kit-visual-backup",
    "prefix-test-results-kit-parity",
    "random",
    ".",
  ]) {
    test(`${suite.name} boundary: ${foreign} actual has no replacement authority`, (t) => {
      const f = boundaryFixture(t, suite);
      writeBytes(join(f.dest, "page.png"), "newer-checkout");
      writeBytes(join(f.artifact, foreign, "page-actual.png"), "foreign-screenshot");
      writeBytes(join(f.artifact, suite.snapshots, "new.png"), "valid-addition");
      const result = boundaryCli(suite, f);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        baselineBytes(f.dest),
        {
          "new.png": "valid-addition",
          "page.png": "newer-checkout",
        },
        "an unrelated actual cannot grant overwrite authority",
      );
    });
  }

  test(`${suite.name} boundary: extraction root named like a suite grants no authority`, (t) => {
    const f = boundaryFixture(t, suite);
    const namedRoot = join(f.root, suite.actuals);
    writeBytes(join(namedRoot, "page-actual.png"), "not-a-suite-descendant");
    writeBytes(join(namedRoot, suite.snapshots, "new.png"), "valid-copy");
    writeBytes(join(f.dest, "page.png"), "newer-checkout");
    const result = boundaryCli(suite, f, [], namedRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(baselineBytes(f.dest), {
      "new.png": "valid-copy",
      "page.png": "newer-checkout",
    });
  });

  for (const [name, code, link] of LINK_CASES) {
    test(`${suite.name} boundary: ${name} link refuses the whole plan without mkdir or writes`, (t) => {
      const f = boundaryFixture(t, suite);
      writeBytes(join(f.artifact, suite.actuals, "a-page-actual.png"), "reviewed");
      writeBytes(join(f.artifact, suite.snapshots, "b-new.png"), "new-copy");
      link(f, suite);
      const before = boundaryTree(f.root);
      const result = boundaryCli(suite, f);
      assert.deepEqual(
        boundaryTree(f.root),
        before,
        "refusal must preserve all fixture bytes and directories",
      );
      assert.notEqual(result.status, 0, "a link is a boundary failure, not an ignored candidate");
      const diagnostic = result.stdout + result.stderr;
      assert.ok(diagnostic.length <= 16_384);
      assert.ok(
        !diagnostic.includes(f.root),
        "human diagnostics must also use safe relative paths",
      );
    });

    test(`${suite.name} boundary JSON: ${name} uses fixed ${code} and bounded diagnostics`, (t) => {
      const f = boundaryFixture(t, suite);
      writeBytes(join(f.artifact, suite.actuals, "a-page-actual.png"), "reviewed");
      link(f, suite);
      const before = boundaryTree(f.root);
      const result = boundaryCli(suite, f, ["--dry-run", "--format", "json"]);
      assert.deepEqual(boundaryTree(f.root), before);
      assert.equal(result.status, 1, "boundary refusal exits 1");
      const report = boundaryJson(suite, result);
      assert.ok(report.errors.some((error) => error.code === code));
      assert.ok(result.stdout.length <= 16_384, "diagnostics must be bounded");
      assert.ok(!result.stdout.includes(f.root), "do not expose absolute fixture paths");
      assert.ok(!result.stdout.includes("outside-canary"), "do not echo source bytes");
      for (const error of report.errors) {
        assert.equal(typeof error.path, "string");
        assert.ok(error.path.length <= 256);
        assert.doesNotMatch(error.path, /^(?:\/|[a-z]:)|(?:^|\/)\.\.(?:\/|$)|[\x00-\x1f\x7f]/i);
      }
    });
  }

  test(`${suite.name} boundary: linked source inside the artifact is still refused`, (t) => {
    const f = boundaryFixture(t, suite);
    writeBytes(join(f.artifact, suite.actuals, "a-page-actual.png"), "reviewed");
    writeBytes(join(f.artifact, "plain.png"), "inside-source");
    symlinkSync(
      join(f.artifact, "plain.png"),
      join(f.artifact, suite.actuals, "z-link-actual.png"),
    );
    const before = boundaryTree(f.root);
    const result = boundaryCli(suite, f);
    assert.deepEqual(boundaryTree(f.root), before);
    assert.notEqual(result.status, 0);
  });

  test(`${suite.name} boundary: linked baseline copy never becomes an addition`, (t) => {
    const f = boundaryFixture(t, suite);
    writeBytes(join(f.artifact, suite.actuals, "a-page-actual.png"), "reviewed");
    mkdirSync(join(f.artifact, suite.snapshots), { recursive: true });
    symlinkSync(join(f.outside, "canary.png"), join(f.artifact, suite.snapshots, "z-copy.png"));
    const before = boundaryTree(f.root);
    const result = boundaryCli(suite, f);
    assert.deepEqual(boundaryTree(f.root), before);
    assert.notEqual(result.status, 0);
  });

  test(`${suite.name} boundary: dry-run is read-only and IDs match apply across extraction roots`, (t) => {
    const reports = [];
    for (const reverse of [false, true]) {
      const f = boundaryFixture(t, suite);
      const entries = [
        [join(suite.actuals, "page-actual.png"), "actual"],
        [join(suite.snapshots, "page.png"), "stale"],
        [join(suite.snapshots, "new.png"), "new"],
        [join(suite.snapshots, "unchanged.png"), "same"],
      ];
      for (const [name, bytes] of reverse ? entries.toReversed() : entries)
        writeBytes(join(f.artifact, name), bytes);
      writeBytes(join(f.dest, "page.png"), "checkout");
      writeBytes(join(f.dest, "unchanged.png"), "same");
      utimesSync(join(f.dest, "unchanged.png"), 946684800, 946684800);
      const before = boundaryTree(f.root);
      const preview = boundaryCli(suite, f, ["--dry-run", "--format", "json"]);
      assert.deepEqual(
        boundaryTree(f.root),
        before,
        "preview must not write or create a directory",
      );
      assert.equal(preview.status, 0, preview.stderr);
      const dryReport = boundaryJson(suite, preview);
      assert.deepEqual(dryReport.errors, []);
      assert.equal(
        dryReport.items.length,
        3,
        "actual and stale copy collapse to one item; no-op stays visible",
      );
      const applied = boundaryCli(suite, f, ["--format", "json"]);
      assert.equal(applied.status, 0, applied.stderr);
      const applyReport = boundaryJson(suite, applied);
      assert.deepEqual(applyReport.errors, []);
      assert.deepEqual(
        applyReport.items.map((i) => i.id).sort(),
        dryReport.items.map((i) => i.id).sort(),
      );
      assert.deepEqual(baselineBytes(f.dest), {
        "new.png": "new",
        "page.png": "actual",
        "unchanged.png": "same",
      });
      assert.equal(statSync(join(f.dest, "unchanged.png")).mtimeMs, 946684800000);
      reports.push(dryReport.items.map((i) => i.id).sort());
    }
    assert.deepEqual(
      reports[0],
      reports[1],
      "IDs must not depend on absolute extraction path or enumeration order",
    );
  });

  test(`${suite.name} boundary: dry-run never creates an absent destination`, (t) => {
    const f = boundaryFixture(t, suite);
    writeBytes(join(f.artifact, suite.actuals, "page-actual.png"), "actual");
    const before = boundaryTree(f.root);
    const result = boundaryCli(suite, f, ["--dry-run"]);
    assert.deepEqual(boundaryTree(f.root), before);
    assert.equal(result.status, 0, result.stderr);
  });

  for (const [kind, code] of [
    ["collision", "PLAN_COLLISION"],
    ["stale copy", "STALE_COPY"],
  ]) {
    test(`${suite.name} boundary: dry-run and apply both refuse ${kind} with ${code}`, (t) => {
      const f = boundaryFixture(t, suite);
      writeBytes(join(f.dest, "a-page.png"), "checkout");
      writeBytes(join(f.artifact, suite.actuals, "a-page-actual.png"), "actual");
      writeBytes(join(f.artifact, suite.snapshots, "b-new.png"), "addition");
      if (kind === "collision") {
        writeBytes(join(f.artifact, suite.actuals, "x/z-conflict-actual.png"), "one");
        writeBytes(join(f.artifact, suite.actuals, "y/z-conflict-actual.png"), "two");
      } else {
        writeBytes(join(f.dest, "z-unrelated.png"), "newer-checkout");
        writeBytes(join(f.artifact, suite.snapshots, "z-unrelated.png"), "stale-copy");
      }
      const before = boundaryTree(f.root);
      for (const flags of [
        ["--dry-run", "--format", "json"],
        ["--format", "json"],
      ]) {
        const result = boundaryCli(suite, f, flags);
        assert.deepEqual(boundaryTree(f.root), before);
        assert.equal(result.status, 1);
        const report = boundaryJson(suite, result);
        assert.ok(report.errors.some((error) => error.code === code));
      }
    });
  }

  test(`${suite.name} boundary: real destination files survive one later source link`, (t) => {
    const f = boundaryFixture(t, suite);
    writeBytes(join(f.dest, "a-page.png"), "checkout");
    writeBytes(join(f.dest, "sentinel.png"), "untouched");
    writeBytes(join(f.artifact, suite.actuals, "a-page-actual.png"), "actual");
    symlinkSync(
      join(f.outside, "canary.png"),
      join(f.artifact, suite.actuals, "z-link-actual.png"),
    );
    const before = boundaryTree(f.root);
    const result = boundaryCli(suite, f);
    assert.deepEqual(boundaryTree(f.root), before);
    assert.notEqual(result.status, 0);
  });

  test(`${suite.name} boundary: API rejects a linked workspace ancestor`, (t) => {
    const f = boundaryFixture(t, suite);
    writeBytes(join(f.artifact, suite.actuals, "page-actual.png"), "actual");
    const alias = join(f.root, "checkout-alias");
    symlinkSync(f.workspace, alias, "dir");
    const before = boundaryTree(f.root);
    const result = attemptAcceptance(suite, f.artifact, alias);
    assert.deepEqual(boundaryTree(f.root), before);
    assert.equal(result.ok, false);
  });

  for (const kind of ["actual", "baseline copy"]) {
    test(`${suite.name} boundary: apply uses ${kind} bytes cached during preflight`, (t) => {
      const f = boundaryFixture(t, suite);
      const source =
        kind === "actual"
          ? join(f.artifact, suite.actuals, "page-actual.png")
          : join(f.artifact, suite.snapshots, "page.png");
      writeBytes(source, "reviewed-original");
      const runner = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      const [script, suite, artifact, workspace, source] = process.argv.slice(1);
      const original = fs.readFileSync;
      let observed = false;
      fs.readFileSync = function(path, ...args) {
        const bytes = original.call(this, path, ...args);
        if (String(path) === source && !observed) {
          observed = true;
          fs.writeFileSync(source, "changed-after-read");
        }
        return bytes;
      };
      syncBuiltinESMExports();
      const { acceptBaselines } = await import(script);
      const result = suite === "Kit"
        ? acceptBaselines(artifact, { cwd: workspace })
        : acceptBaselines(artifact, join(workspace, "e2e/visual/__screenshots__"));
      if (!observed || result.ok === false) process.exitCode = 1;
    `;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          runner,
          suite.script.href,
          suite.name,
          f.artifact,
          f.workspace,
          source,
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          cwd: f.workspace,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(source, "utf8"),
        "changed-after-read",
        "the mutation must actually run",
      );
      assert.equal(readFileSync(join(f.dest, "page.png"), "utf8"), "reviewed-original");
    });
  }

  test(`${suite.name} boundary JSON: unreadable source fails safely before any writes`, (t) => {
    const f = boundaryFixture(t, suite);
    writeBytes(join(f.dest, "a-page.png"), "checkout");
    writeBytes(join(f.artifact, suite.actuals, "a-page-actual.png"), "actual");
    const unreadable = join(f.artifact, suite.actuals, "z-unreadable-actual.png");
    writeBytes(unreadable, "unreadable-source");
    // Inject only the read failure: permission bits are ineffective under root.
    const preload = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        if (String(path) === ${JSON.stringify(unreadable)}) {
          const error = new Error("EACCES sensitive-raw-diagnostic " + path);
          error.code = "EACCES";
          throw error;
        }
        return original.call(this, path, ...args);
      };
      syncBuiltinESMExports();
    `;
    const before = boundaryTree(f.root);
    for (const flags of [
      ["--dry-run", "--format", "json"],
      ["--format", "json"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
          suite.script.pathname,
          f.artifact,
          ...flags,
        ],
        { encoding: "utf8", timeout: 5_000, cwd: f.workspace },
      );
      assert.equal(result.error, undefined);
      assert.deepEqual(boundaryTree(f.root), before);
      assert.equal(result.status, 1);
      const report = boundaryJson(suite, result);
      assert.ok(report.errors.some((error) => error.code === "SOURCE_UNREADABLE"));
      assert.ok(!result.stdout.includes(f.root));
      assert.ok(!result.stdout.includes("sensitive-raw-diagnostic"));
    }
  });

  for (const [name, build] of [
    ["depth", (f) => writeBytes(join(f.artifact, ...Array(65).fill("d"), "ignored.txt"), "deep")],
    [
      "entry count",
      (f) => {
        for (let i = 0; i < 4097; i++) writeBytes(join(f.artifact, `unrelated-${i}.txt`), "entry");
      },
    ],
  ]) {
    test(`${suite.name} boundary: traversal has a shared finite ${name} budget`, (t) => {
      const f = boundaryFixture(t, suite);
      writeBytes(join(f.artifact, suite.actuals, "page-actual.png"), "actual");
      build(f);
      const before = boundaryTree(f.root);
      const result = boundaryCli(suite, f, ["--format", "json"]);
      assert.deepEqual(boundaryTree(f.root), before);
      assert.equal(result.status, 1);
      const report = boundaryJson(suite, result);
      assert.ok(report.errors.some((error) => error.code === "ARTIFACT_LIMIT"));
      assert.ok(result.stdout.length <= 16_384);
    });
  }

  test(`${suite.name} boundary JSON: hostile link names cannot inject raw diagnostics`, (t) => {
    const f = boundaryFixture(t, suite);
    writeBytes(join(f.artifact, suite.actuals, "a-page-actual.png"), "actual");
    symlinkSync(
      join(f.outside, "canary.png"),
      join(f.artifact, suite.actuals, `z-${"x".repeat(170)}-\u001b[31m\n-actual.png`),
    );
    const before = boundaryTree(f.root);
    const result = boundaryCli(suite, f, ["--format", "json"]);
    assert.deepEqual(boundaryTree(f.root), before);
    assert.equal(result.status, 1);
    const report = boundaryJson(suite, result);
    assert.ok(report.errors.some((error) => error.code === "SOURCE_SYMLINK"));
    assert.ok(result.stdout.length <= 16_384);
    assert.ok(!result.stdout.includes(f.root));
    for (const error of report.errors) {
      assert.ok(error.path.length <= 256);
      assert.doesNotMatch(error.path, /[\x00-\x1f\x7f]/);
    }
  });

  test(`${suite.name} boundary flags: invalid arguments win before filesystem validation`, (t) => {
    const f = boundaryFixture(t, suite);
    const before = boundaryTree(f.root);
    const result = boundaryCli(
      suite,
      f,
      ["--format", "json", "--unknown"],
      join(f.root, "missing-artifact"),
    );
    assert.deepEqual(boundaryTree(f.root), before);
    assert.equal(result.status, 2);
    const report = boundaryJson(suite, result);
    assert.ok(report.errors.some((error) => error.code === "INVALID_ARGUMENTS"));
  });

  for (const flags of [
    ["--unknown"],
    ["extra-artifact"],
    ["--dry-run=true"],
    ["--dry-run", "false"],
    ["--format"],
    ["--format", "yaml"],
    ["--format=json"],
    ["--format", "json", "--format", "json"],
    ["--dry-run", "--dry-run"],
    ["--format", "json", "--unknown"],
  ]) {
    test(`${suite.name} boundary flags: ${flags.join(" ")} refuses before writes`, (t) => {
      const f = boundaryFixture(t, suite);
      writeBytes(join(f.artifact, suite.actuals, "page-actual.png"), "actual");
      const before = boundaryTree(f.root);
      const result = boundaryCli(suite, f, flags);
      assert.deepEqual(
        boundaryTree(f.root),
        before,
        "invalid arguments must not apply the valid plan",
      );
      assert.equal(result.status, 2, "usage errors exit 2");
      if (flags.includes("json")) {
        const report = boundaryJson(suite, result);
        assert.ok(report.errors.some((error) => error.code === "INVALID_ARGUMENTS"));
      }
    });
  }
}
