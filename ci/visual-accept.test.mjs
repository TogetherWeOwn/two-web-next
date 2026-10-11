import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("ci/visual-accept.mjs");

test("copies only *-actual.png files over their baselines", () => {
  const cwd = mkdtempSync(join(tmpdir(), "visual-accept-"));
  const art = join(cwd, "artifact", "test-results-visual", "public-pages-home");
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, "home-desktop-actual.png"), "new");
  writeFileSync(join(art, "home-desktop-diff.png"), "diff");
  writeFileSync(join(art, "home-desktop-expected.png"), "old");
  const r = spawnSync(process.execPath, [script, join(cwd, "artifact")], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    readFileSync(join(cwd, "e2e/visual/__screenshots__/home-desktop.png"), "utf8"),
    "new",
  );
  assert.throws(() => readFileSync(join(cwd, "e2e/visual/__screenshots__/home-desktop-diff.png")));
});

test("copies new baselines the run wrote under __screenshots__", () => {
  const cwd = mkdtempSync(join(tmpdir(), "visual-accept-"));
  const shots = join(cwd, "artifact", "e2e", "visual", "__screenshots__");
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, "rules-mobile.png"), "fresh");
  const r = spawnSync(process.execPath, [script, join(cwd, "artifact")], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    readFileSync(join(cwd, "e2e/visual/__screenshots__/rules-mobile.png"), "utf8"),
    "fresh",
  );
});

test("fails when the artifact holds no actual screenshots", () => {
  const cwd = mkdtempSync(join(tmpdir(), "visual-accept-"));
  mkdirSync(join(cwd, "artifact"), { recursive: true });
  const r = spawnSync(process.execPath, [script, join(cwd, "artifact")], { cwd, encoding: "utf8" });
  assert.equal(r.status, 1);
});

test("requires an artifact directory argument", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 2);
});
