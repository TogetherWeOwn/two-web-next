import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
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
  writeBytes(join(artifact, "a", "home-actual.png"), "candidate-a-bytes");
  writeBytes(join(artifact, "b", "home-actual.png"), "candidate-b-bytes");
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
  writeBytes(join(artifact, "run", "home-actual.png"), "actual-bytes");
  writeBytes(
    join(artifact, "run", "e2e", "visual", "__screenshots__", "home.png"),
    "stale-baseline-bytes",
  );
  writeBytes(join(artifact, "run", "about-actual.png"), "about-bytes");
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
  writeBytes(join(artifact, "a", "home-actual.png"), "same-bytes");
  writeBytes(join(artifact, "b", "home-actual.png"), "same-bytes");

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
  writeBytes(join(artifact, "a", "home-actual.png"), "candidate-a-bytes");
  writeBytes(join(artifact, "b", "home-actual.png"), "candidate-b-bytes");

  const { result } = runAccept(workspace, artifact);

  assert.notEqual(result.status, 0, `expected refusal, stdout: ${result.stdout}`);
  assert.match(result.stderr, /home\.png/);
  assert.throws(() => statSync(join(workspace, "e2e", "visual", "__screenshots__")));
});

test("non-colliding actual and new baselines are still accepted", () => {
  const workspace = scratchRoot("visual-accept-ok-");
  const artifact = join(workspace, "artifact");
  writeBytes(join(artifact, "run", "home-actual.png"), "home-bytes");
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
  writeBytes(join(artifact, "run", "home-actual.png"), "actual-bytes");
  writeBytes(join(artifact, "run", "e2e", "visual", "__screenshots__", "home.png"), "stale-bytes");

  const { written, dropped } = acceptBaselines(artifact, destDir);

  assert.equal(written, 1);
  assert.equal(dropped, 1);
  assert.equal(readFileSync(join(destDir, "home.png"), "utf8"), "actual-bytes");

  writeBytes(join(artifact, "other", "home-actual.png"), "different-bytes");
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
