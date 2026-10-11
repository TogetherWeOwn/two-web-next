// Floor-guard fixtures (RED first): the CONSTRAINTS.md floor must fail when a
// diff adds suppressions, skips or deletes tests, strips assertions, adds
// stubs, adds an exception row, or lowers a threshold — and stay silent on a
// clean diff or a tightening change.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { guardDiff } from "./floor-guard.mjs";

const diff = (body) => `diff --git a/x b/x\n${body}`;

describe("floor-guard", () => {
  it("is silent on a clean diff", () => {
    const d = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +2 @@",
      "+export const x = 1;",
    ].join("\n");
    assert.deepEqual(guardDiff(d), []);
  });

  it("flags an added @ts-ignore suppression", () => {
    const findings = guardDiff(
      diff("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2 @@\n+// @ts-ignore: temp\n"),
    );
    assert.ok(findings.some((f) => f.rule === "silenced-checker"));
  });

  it("flags an added biome-ignore suppression", () => {
    const findings = guardDiff(
      diff("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2 @@\n+// biome-ignore lint: temp\n"),
    );
    assert.ok(findings.some((f) => f.rule === "silenced-checker"));
  });

  it("flags an added skip", () => {
    const findings = guardDiff(
      diff('--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1,0 +2 @@\n+it.skip("x", () => {});\n'),
    );
    assert.ok(findings.some((f) => f.rule === "test-made-easier"));
  });

  it("flags an added not-implemented stub", () => {
    const findings = guardDiff(
      diff('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2 @@\n+throw new Error("Not implemented");\n'),
    );
    assert.ok(findings.some((f) => f.rule === "unfinished-work"));
  });

  it("flags a deleted test file", () => {
    const d = [
      "diff --git a/test/gone.test.ts b/test/gone.test.ts",
      "deleted file mode 100644",
      "--- a/test/gone.test.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      '-it("x", () => {',
      "-});",
    ].join("\n");
    const findings = guardDiff(d);
    assert.ok(findings.some((f) => f.rule === "test-deleted"));
  });

  it("flags an assertion stripped from a surviving test", () => {
    const findings = guardDiff(
      diff("--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1 +1 @@\n-expect(x).toBe(1);\n"),
    );
    assert.ok(findings.some((f) => f.rule === "assertion-removed"));
  });

  it("stays silent when a removed assertion is replaced in the same file", () => {
    const findings = guardDiff(
      diff(
        "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1,2 +1,2 @@\n-expect(true).toBe(true);\n+expect(titles.has(section), section).toBe(true);\n",
      ),
    );
    assert.deepEqual(
      findings.filter((f) => f.rule === "assertion-removed"),
      [],
    );
  });

  it("still flags a net strip when more assertions leave than arrive", () => {
    const findings = guardDiff(
      diff(
        "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1,3 +1,2 @@\n-expect(x).toBe(1);\n-expect(y).toBe(2);\n+expect(x).toBe(1);\n",
      ),
    );
    assert.equal(findings.filter((f) => f.rule === "assertion-removed").length, 1);
  });

  it("flags a lowered threshold in CONSTRAINTS.md", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +1 @@\n-| Coverage | Changed lines ≥ 80% covered | vitest |\n+| Coverage | Changed lines ≥ 70% covered | vitest |\n",
      ),
    );
    assert.ok(findings.some((f) => f.rule === "threshold-lowered"));
  });

  it("stays silent when a threshold is tightened", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +1 @@\n-| Coverage | Changed lines ≥ 80% covered | vitest |\n+| Coverage | Changed lines ≥ 90% covered | vitest |\n",
      ),
    );
    assert.deepEqual(findings, []);
  });

  it("flags a new exception row in CONSTRAINTS.md", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1,0 +2 @@\n+| W1 | `no-explicit-any` | `src/legacy/**` | rewrite | @x | 2027-01-01 |\n",
      ),
    );
    assert.ok(findings.some((f) => f.rule === "new-exception"));
  });

  it("honors ignore globs for added-line content rules", () => {
    const d = diff(
      "--- a/ci/floor-guard.mjs\n+++ b/ci/floor-guard.mjs\n@@ -1,0 +2 @@\n+// biome-ignore lint: pattern list mentions the form it detects\n",
    );
    assert.deepEqual(guardDiff(d, { ignore: ["ci/floor-guard.*"] }), []);
    assert.ok(
      guardDiff(d).some((f) => f.rule === "silenced-checker"),
      "fires without the ignore entry",
    );
  });

  it("never lets ignore silence thresholds, exceptions or deletions", () => {
    const lowered = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +1 @@\n-| Coverage | Changed lines ≥ 80% covered | vitest |\n+| Coverage | Changed lines ≥ 70% covered | vitest |\n",
      ),
      { ignore: ["CONSTRAINTS.md"] },
    );
    assert.ok(lowered.some((f) => f.rule === "threshold-lowered"));
    const deleted = guardDiff(
      [
        "diff --git a/test/gone.test.ts b/test/gone.test.ts",
        "deleted file mode 100644",
        "--- a/test/gone.test.ts",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        '-it("x", () => {',
        "-});",
      ].join("\n"),
      { ignore: ["test/**"] },
    );
    assert.ok(deleted.some((f) => f.rule === "test-deleted"));
  });

  it("sees untracked files end to end (a diff means exit 1, not dropped stdout)", () => {
    // Regression pin: `git diff` exits 1 when a diff exists, so plumbing that
    // drops stdout on non-zero exit reports a violating tree as clean.
    const dir = mkdtempSync(join(tmpdir(), "floor-guard-e2e-"));
    try {
      const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const guard = join(dirname(fileURLToPath(import.meta.url)), "floor-guard.mjs");
      const run = () =>
        spawnSync("node", [guard, "--base", "HEAD"], { cwd: dir, encoding: "utf8" });
      assert.equal(run().status, 0, "clean tree exits 0");
      writeFileSync(join(dir, "b.ts"), "// eslint-disable-next-line no-any\n");
      const bad = run();
      assert.equal(bad.status, 1, "untracked suppression exits 1");
      assert.match(bad.stderr, /silenced-checker/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
