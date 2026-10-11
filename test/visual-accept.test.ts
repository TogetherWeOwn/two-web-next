import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("ci/visual-accept.mjs");
const run = (args: string[], cwd?: string) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });

describe("ci/visual-accept.mjs", () => {
  it("copies *-actual.png over the baseline and ignores diff/expected images", () => {
    const cwd = mkdtempSync(join(tmpdir(), "visual-accept-"));
    const art = join(cwd, "artifact", "test-results-visual", "public-pages-home");
    mkdirSync(art, { recursive: true });
    writeFileSync(join(art, "home-desktop-actual.png"), "new");
    writeFileSync(join(art, "home-desktop-diff.png"), "diff");
    writeFileSync(join(art, "home-desktop-expected.png"), "old");
    const r = run([join(cwd, "artifact")], cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(cwd, "e2e/visual/__screenshots__/home-desktop.png"), "utf8")).toBe(
      "new",
    );
    expect(() =>
      readFileSync(join(cwd, "e2e/visual/__screenshots__/home-desktop-diff.png")),
    ).toThrow();
  });

  it("copies new baselines the run wrote under __screenshots__", () => {
    const cwd = mkdtempSync(join(tmpdir(), "visual-accept-"));
    const shots = join(cwd, "artifact", "e2e", "visual", "__screenshots__");
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, "rules-mobile.png"), "fresh");
    const r = run([join(cwd, "artifact")], cwd);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(cwd, "e2e/visual/__screenshots__/rules-mobile.png"), "utf8")).toBe(
      "fresh",
    );
  });

  it("fails when the artifact holds no screenshots", () => {
    const cwd = mkdtempSync(join(tmpdir(), "visual-accept-"));
    mkdirSync(join(cwd, "artifact"), { recursive: true });
    expect(run([join(cwd, "artifact")], cwd).status).toBe(1);
  });

  it("requires an artifact directory argument", () => {
    expect(run([]).status).toBe(2);
  });
});
