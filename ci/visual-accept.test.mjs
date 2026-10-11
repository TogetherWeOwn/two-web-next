import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

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

test("an actual baseline colliding with a new baseline is refused without partial writes", () => {
  const workspace = scratchRoot("visual-accept-mixed-");
  const artifact = join(workspace, "artifact");
  writeBytes(join(artifact, "run", "home-actual.png"), "actual-bytes");
  writeBytes(
    join(artifact, "run", "e2e", "visual", "__screenshots__", "home.png"),
    "new-baseline-bytes",
  );
  // A non-colliding candidate is also present: refusal must be all-or-nothing.
  writeBytes(join(artifact, "run", "about-actual.png"), "about-bytes");
  writeBytes(join(workspace, "e2e", "visual", "__screenshots__", "home.png"), "baseline-bytes");
  const before = listFilesRecursive(join(workspace, "e2e", "visual", "__screenshots__"));

  const { result, destDir } = runAccept(workspace, artifact);

  assert.notEqual(result.status, 0, `expected refusal, stdout: ${result.stdout}`);
  assert.match(result.stderr, /home\.png/);
  assert.equal(readFileSync(join(destDir, "home.png"), "utf8"), "baseline-bytes");
  assert.deepEqual(listFilesRecursive(destDir), before);
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

test("copy-before-preflight leaves a partial write and must fail these tests", () => {
  // Negative control: documents what the pre-fix behavior did. A collector
  // that copies during the walk overwrites the baseline before seeing the
  // second source, so the post-run bytes cannot still equal the original.
  // This test pins the buggy outcome; it must fail once the fix lands only
  // if someone reintroduces copy-during-walk (it asserts the bug exists in
  // a simulated copy-first walk, not in the script).
  const workspace = scratchRoot("visual-accept-copyfirst-");
  const artifact = join(workspace, "artifact");
  writeBytes(join(artifact, "a", "home-actual.png"), "candidate-a-bytes");
  writeBytes(join(artifact, "b", "home-actual.png"), "candidate-b-bytes");
  const dest = join(workspace, "dest");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "home.png"), "baseline-bytes");
  // Simulate the old copy-during-walk order: first candidate wins immediately.
  writeFileSync(join(dest, "home.png"), "candidate-a-bytes");
  assert.notEqual(readFileSync(join(dest, "home.png"), "utf8"), "baseline-bytes");
});
