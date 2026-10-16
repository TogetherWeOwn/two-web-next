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
import { acceptBaselines } from "./visual-accept.mjs";

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
