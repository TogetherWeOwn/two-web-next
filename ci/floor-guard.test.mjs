// Floor-guard fixtures (RED first): the CONSTRAINTS.md floor must fail when a
// diff adds suppressions, skips or deletes tests, strips assertions, adds
// stubs, adds an exception row, or lowers a threshold — and stay silent on a
// clean diff or a tightening change.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { guardDiff, loadIgnore, parseFloorWaivers } from "./floor-guard.mjs";

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

  it("flags test skip calls but not property reads or prose", () => {
    // Fixture skip calls are built by concatenation so this file's own source
    // never contains the contiguous skip literal the guard detects.
    const skipLine = "+it." + 'skip("x", () => {});\n';
    const property = guardDiff(
      diff(
        "--- a/ci/a11y-policy.test.mjs\n+++ b/ci/a11y-policy.test.mjs\n@@ -1,0 +2 @@\n+assert.equal(entry.skip, true);\n",
      ),
    );
    const docs = guardDiff(
      diff(
        "--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1,0 +2 @@\n+TODO: test.skip is mentioned here as documentation.\n",
      ),
    );
    assert.deepEqual(
      property.filter((f) => f.rule === "test-made-easier"),
      [],
    );
    assert.deepEqual(
      docs.filter((f) => f.rule === "unfinished-work" || f.rule === "test-made-easier"),
      [],
    );
    assert.ok(
      guardDiff(
        diff("--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1,0 +2 @@\n" + skipLine),
      ).some((f) => f.rule === "test-made-easier"),
    );
  });

  it("flags an added skip", () => {
    const findings = guardDiff(
      diff(
        "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1,0 +2 @@\n+it." +
          'skip("x", () => {});\n',
      ),
    );
    assert.ok(findings.some((f) => f.rule === "test-made-easier"));
  });

  it("still flags a skip added to the guard's own test file", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const ignore = loadIgnore(root);
    assert.ok(ignore.includes("ci/floor-guard.test.mjs"));
    const d = diff(
      "--- a/ci/floor-guard.test.mjs\n+++ b/ci/floor-guard.test.mjs\n@@ -1,0 +2 @@\n+it." +
        'skip("x", () => {});\n',
    );
    assert.ok(
      guardDiff(d, { ignore }).some((f) => f.rule === "test-made-easier"),
      "ignore covers suppressions and stubs, never skips",
    );
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

  it("flags a test file renamed out of the test glob as a deletion", () => {
    // git rename detection sends a `git mv` as rename headers with no
    // ---/+++ lines, which a deletion-only parser reads as clean.
    const renamed = [
      "diff --git a/test/a.test.ts b/docs/a.txt",
      "similarity index 100%",
      "rename from test/a.test.ts",
      "rename to docs/a.txt",
    ].join("\n");
    assert.ok(
      guardDiff(renamed).some((f) => f.rule === "test-deleted"),
      "moving a test out of the suite needs a test-deleted waiver",
    );
  });

  it("flags a test file renamed to a non-runner suffix as a deletion", () => {
    // `test/a.test.ts.disabled` still contains `.test.` but no runner picks
    // it up (vitest includes only *.test.ts / *.test.mjs), so it is a move
    // out of the suite, not a keep.
    const disabled = [
      "diff --git a/test/a.test.ts b/test/a.test.ts.disabled",
      "similarity index 100%",
      "rename from test/a.test.ts",
      "rename to test/a.test.ts.disabled",
    ].join("\n");
    assert.ok(
      guardDiff(disabled).some((f) => f.rule === "test-deleted"),
      "disabling a test by suffix needs a test-deleted waiver",
    );
  });

  it("flags assertions stripped in a partial rename to a non-test path", () => {
    // A partial rename attributes removed lines to the destination unless the
    // parser maps them back to the old path.
    const partial = [
      "diff --git a/test/big.test.ts b/docs/big.txt",
      "similarity index 95%",
      "rename from test/big.test.ts",
      "rename to docs/big.txt",
      "--- a/test/big.test.ts",
      "+++ b/docs/big.txt",
      "@@ -1 +0,0 @@",
      "-expect(3).toBe(3);",
    ].join("\n");
    const findings = guardDiff(partial);
    assert.ok(
      findings.some((f) => f.rule === "assertion-removed"),
      "stripped assertion in a moved test still fails",
    );
    assert.ok(
      findings.some((f) => f.rule === "test-deleted"),
      "moving a test out of the suite still fails",
    );
  });

  it("stays silent on a rename that keeps a runnable test path", () => {
    const kept = [
      "diff --git a/test/a.test.ts b/test/unit/a.test.ts",
      "similarity index 100%",
      "rename from test/a.test.ts",
      "rename to test/unit/a.test.ts",
    ].join("\n");
    assert.deepEqual(guardDiff(kept), []);
  });

  it("stays silent on a rename with a one-for-one assertion swap", () => {
    // Removed lines pair against added lines at the destination: moving a
    // test and tweaking one assertion is a refactor, not a strip.
    const swapped = [
      "diff --git a/test/a.test.ts b/test/unit/a.test.ts",
      "similarity index 90%",
      "rename from test/a.test.ts",
      "rename to test/unit/a.test.ts",
      "--- a/test/a.test.ts",
      "+++ b/test/unit/a.test.ts",
      "@@ -1 +1 @@",
      "-expect(1).toBe(1);",
      "+expect(1).toBeLessThan(2);",
    ].join("\n");
    assert.deepEqual(
      guardDiff(swapped).filter((f) => f.rule === "assertion-removed"),
      [],
    );
  });

  it("still flags a net strip in a renamed test", () => {
    const stripped = [
      "diff --git a/test/a.test.ts b/test/unit/a.test.ts",
      "similarity index 90%",
      "rename from test/a.test.ts",
      "rename to test/unit/a.test.ts",
      "--- a/test/a.test.ts",
      "+++ b/test/unit/a.test.ts",
      "@@ -1,2 +1 @@",
      "-expect(1).toBe(1);",
      "-expect(2).toBe(2);",
      "+expect(1).toBeLessThan(2);",
    ].join("\n");
    const findings = guardDiff(stripped);
    assert.equal(findings.filter((f) => f.rule === "assertion-removed").length, 1);
  });

  it("flags a test renamed to a test-looking name outside the runner globs", () => {
    // Vitest includes only test/**/*.test.ts and test/**/*.test.mjs, so a
    // move to docs/ or to a .test.js suffix leaves the suite even though the
    // name still matches the test pattern.
    for (const dest of ["docs/a.test.ts", "test/a.test.js"]) {
      const renamed = [
        `diff --git a/test/a.test.ts b/${dest}`,
        "similarity index 100%",
        "rename from test/a.test.ts",
        `rename to ${dest}`,
      ].join("\n");
      assert.ok(
        guardDiff(renamed).some((f) => f.rule === "test-deleted"),
        `${dest} is outside the runner globs and needs a test-deleted waiver`,
      );
    }
  });

  it("accepts reasoned, path-scoped floor waivers for test removals", () => {
    const deletion = [
      "diff --git a/test/gone.test.ts b/test/gone.test.ts",
      "deleted file mode 100644",
      "--- a/test/gone.test.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      '-it("x", () => {',
      "-});",
    ].join("\n");
    const waived = parseFloorWaivers(
      "cleanup tests\n\nFloor-waiver: test-deleted test/gone.test.ts -- replaced by the new suite\n",
    );
    assert.deepEqual(guardDiff(deletion, { waivers: waived }), []);
    assert.ok(
      guardDiff(deletion, {
        waivers: parseFloorWaivers("Floor-waiver: test-deleted test/gone.test.ts"),
      }).some((f) => f.rule === "test-deleted"),
      "waiver without a reason is ignored",
    );
  });

  it("accepts a reasoned assertion-removal waiver only for its named test", () => {
    const d = diff(
      "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1 +0,0 @@\n-expect(x).toBe(1);\n",
    );
    const waived = parseFloorWaivers(
      "Floor-waiver: assertion-removed test/a.test.ts -- assertion moved to the replacement suite\n",
    );
    assert.deepEqual(guardDiff(d, { waivers: waived }), []);
    assert.ok(guardDiff(d, { waivers: new Map() }).some((f) => f.rule === "assertion-removed"));
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
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +1 @@\n-| Coverage | Changed lines ≥ 80% covered | `npm run patch:coverage` |\n+| Coverage | Changed lines ≥ 70% covered | `npm run patch:coverage` |\n",
      ),
    );
    assert.ok(findings.some((f) => f.rule === "threshold-lowered"));
  });

  it("stays silent when a threshold is tightened", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +1 @@\n-| Coverage | Changed lines ≥ 80% covered | `npm run patch:coverage` |\n+| Coverage | Changed lines ≥ 90% covered | `npm run patch:coverage` |\n",
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

  it("pairs changed thresholds by table label, not row position", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1,3 +1,4 @@\n-| Coverage | Changed lines ≥ 80% covered | `npm run patch:coverage` |\n-| Lint | Zero errors | `npm run lint` |\n+| New metric | 70% minimum | tool |\n+| Coverage | Changed lines ≥ 90% covered | `npm run patch:coverage` |\n+| Lint | Zero errors | `npm run lint` |\n",
      ),
    );
    assert.deepEqual(
      findings.filter((f) => f.rule === "threshold-lowered"),
      [],
    );
  });

  it("catches one lowered row among other threshold changes", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1,2 +1,3 @@\n+| New metric | 95% minimum | tool |\n+| Coverage | Changed lines ≥ 90% covered | `npm run patch:coverage` |\n+| Mutation | Kills ≥ 80% | `npm run mutation` |\n-| Coverage | Changed lines ≥ 80% covered | `npm run patch:coverage` |\n-| Mutation | Kills ≥ 90% | `npm run mutation` |\n",
      ),
    );
    assert.equal(findings.filter((f) => f.rule === "threshold-lowered").length, 1);
    assert.match(findings.find((f) => f.rule === "threshold-lowered").text, /Mutation/);
  });

  it("ignores date changes outside threshold table rows", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +1 @@\n-Last reviewed: 2026-10-11.\n+Last reviewed: 2026-11-02.\n",
      ),
    );
    assert.deepEqual(
      findings.filter((f) => f.rule === "threshold-lowered"),
      [],
    );
  });

  it("ignores generated island bundles with existing empty catches", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const ignore = loadIgnore(root);
    const d = diff(
      "--- a/public/islands/auth-status.js\n+++ b/public/islands/auth-status.js\n@@ -1 +1 @@\n-old output\n+(()=>{try{}catch{}})();\n",
    );
    assert.ok(ignore.includes("public/**"));
    assert.deepEqual(guardDiff(d, { ignore }), []);
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
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +1 @@\n-| Coverage | Changed lines ≥ 80% covered | `npm run patch:coverage` |\n+| Coverage | Changed lines ≥ 70% covered | `npm run patch:coverage` |\n",
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

  it("flags a deleted *-selftest script as a test deletion", () => {
    const d = [
      "diff --git a/ci/cutover-check-selftest.mjs b/ci/cutover-check-selftest.mjs",
      "deleted file mode 100644",
      "--- a/ci/cutover-check-selftest.mjs",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-assert.equal(a, b);",
      "-});",
    ].join("\n");
    assert.ok(guardDiff(d).some((f) => f.rule === "test-deleted"));
  });

  it("flags assertions stripped from a *-selftest script", () => {
    const findings = guardDiff(
      diff(
        "--- a/ci/cutover-check-selftest.mjs\n+++ b/ci/cutover-check-selftest.mjs\n@@ -1 +1 @@\n-assert.equal(a, b);\n",
      ),
    );
    assert.ok(findings.some((f) => f.rule === "assertion-removed"));
  });

  it("flags a renamed-then-lowered threshold via its Checked-by cell", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +1 @@\n-| Coverage of changed lines | Added TS lines ≥ 80% executed | `npm run patch:coverage` | CI |\n+| Changed-line coverage | Added TS lines ≥ 50% executed | `npm run patch:coverage` | CI |\n",
      ),
    );
    assert.ok(findings.some((f) => f.rule === "threshold-lowered"));
  });

  it("stays silent on a rename that keeps the numbers", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +1 @@\n-| Coverage of changed lines | Added TS lines ≥ 80% executed | `npm run patch:coverage` | CI |\n+| Changed-line coverage | Added TS lines ≥ 80% executed | `npm run patch:coverage` | CI |\n",
      ),
    );
    assert.deepEqual(
      findings.filter((f) => f.rule === "threshold-lowered" || f.rule === "threshold-removed"),
      [],
    );
  });

  it("flags a deleted enforced-threshold row", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +0,0 @@\n-| Accessibility | Zero critical or serious violations on fixtures | `npm run a11y` | `a11y` job |\n",
      ),
    );
    assert.ok(findings.some((f) => f.rule === "threshold-removed"));
  });

  it("ignores removed rows outside the enforced table", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +0,0 @@\n-| Project coverage | 62.4% | must not fall |\n",
      ),
    );
    assert.deepEqual(
      findings.filter((f) => f.rule === "threshold-removed"),
      [],
    );
  });

  it("does not read an exception-row removal as a threshold removal", () => {
    const findings = guardDiff(
      diff(
        "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +0,0 @@\n-| W1 | `no-explicit-any` | `src/legacy/**` | rewrite | @x | 2027-01-01 |\n",
      ),
    );
    assert.deepEqual(
      findings.filter((f) => f.rule === "threshold-removed"),
      [],
    );
  });

  it("flags an added .constraintsignore glob as a new exemption", () => {
    const findings = guardDiff(
      diff("--- a/.constraintsignore\n+++ b/.constraintsignore\n@@ -1,0 +2 @@\n+src/**\n"),
      { baseIgnore: ["public/**"] },
    );
    assert.ok(findings.some((f) => f.rule === "new-exemption"));
  });

  it("lets a reasoned waiver cover a threshold removal or ignore addition", () => {
    const deletion = diff(
      "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +0,0 @@\n-| Accessibility | Zero critical or serious violations on fixtures | `npm run a11y` | `a11y` job |\n",
    );
    const waived = parseFloorWaivers(
      "retire dimension\n\nFloor-waiver: threshold-removed Accessibility -- moved to the nightly audit\n",
    );
    assert.deepEqual(guardDiff(deletion, { waivers: waived }), []);
    const ignoreAdd = diff(
      "--- a/.constraintsignore\n+++ b/.constraintsignore\n@@ -1,0 +2 @@\n+src/**\n",
    );
    const waivedIgnore = parseFloorWaivers(
      "exempt generated\n\nFloor-waiver: new-exemption .constraintsignore -- generated output reviewed against source\n",
    );
    assert.deepEqual(guardDiff(ignoreAdd, { waivers: waivedIgnore, baseIgnore: [] }), []);
  });

  it("lets a reasoned waiver name a multi-word threshold dimension", () => {
    const deletion = diff(
      "--- a/CONSTRAINTS.md\n+++ b/CONSTRAINTS.md\n@@ -1 +0,0 @@\n-| Coverage of changed lines | Added TS lines ≥ 80% executed | `npm run patch:coverage` | CI |\n",
    );
    const waived = parseFloorWaivers(
      "retire dimension\n\nFloor-waiver: threshold-removed Coverage of changed lines -- moved to the nightly audit\n",
    );
    assert.deepEqual(guardDiff(deletion, { waivers: waived }), []);
    const wrongLabel = parseFloorWaivers(
      "retire dimension\n\nFloor-waiver: threshold-removed Lint -- moved to the nightly audit\n",
    );
    assert.ok(
      guardDiff(deletion, { waivers: wrongLabel }).some((f) => f.rule === "threshold-removed"),
      "a waiver for another dimension must not cover the deletion",
    );
    assert.ok(
      guardDiff(deletion, { waivers: new Map() }).some((f) => f.rule === "threshold-removed"),
    );
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
      rmSync(join(dir, "b.ts"));
      writeFileSync(
        join(dir, "large.ts"),
        `${"x".repeat(1_200_000)}// eslint-disable-next-line no-any\n`,
      );
      const large = run();
      assert.equal(large.status, 1, "large diff still reports the suppression");
      assert.match(large.stderr, /silenced-checker/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pins .constraintsignore to the merge base end to end", () => {
    // A branch-added ignore entry must not silence its own suppression:
    // reading HEAD would exit 0, reading the base exits 1 with new-exemption.
    const dir = mkdtempSync(join(tmpdir(), "floor-guard-basepin-"));
    try {
      const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      writeFileSync(join(dir, ".constraintsignore"), "public/**\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]).stdout.trim();
      writeFileSync(join(dir, ".constraintsignore"), "public/**\nsrc/**\n");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "x.ts"), "// @ts-ignore: probe\n");
      git(["add", "."]);
      git(["commit", "-qm", "branch adds exemption and suppression"]);
      const guard = join(dirname(fileURLToPath(import.meta.url)), "floor-guard.mjs");
      const bad = spawnSync("node", [guard, "--base", base], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(bad.status, 1, "branch-added exemption fails");
      assert.match(bad.stderr, /new-exemption/);
      assert.match(bad.stderr, /silenced-checker/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads waivers from the full branch range end to end", () => {
    // The waiver lives on an earlier branch commit and the tip is plain: a
    // last-commit-only log range would miss it and exit 1. An empty waiver
    // map (unwired parseFloorWaivers) would also exit 1.
    const dir = mkdtempSync(join(tmpdir(), "floor-guard-waiverrange-"));
    try {
      const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "a.test.ts"), "expect(x).toBe(1);\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]).stdout.trim();
      git(["rm", "-q", "test/a.test.ts"]);
      git([
        "commit",
        "-qm",
        "remove obsolete test",
        "-m",
        "Floor-waiver: test-deleted test/a.test.ts -- replaced by the new suite",
      ]);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "b.ts"), "export const y = 2;\n");
      git(["add", "."]);
      git(["commit", "-qm", "plain follow-up"]);
      const guard = join(dirname(fileURLToPath(import.meta.url)), "floor-guard.mjs");
      const run = spawnSync("node", [guard, "--base", base], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(run.status, 0, "non-tip waiver covers the deletion");
      assert.match(run.stdout, /Floor-waiver: test-deleted test\/a\.test\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets a non-tip new-exemption waiver pass end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "floor-guard-ignorewaiver-"));
    try {
      const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      writeFileSync(join(dir, ".constraintsignore"), "public/**\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]).stdout.trim();
      writeFileSync(join(dir, ".constraintsignore"), "public/**\nsrc/**\n");
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "x.ts"), "// @ts-ignore: probe\n");
      git(["add", "."]);
      git([
        "commit",
        "-qm",
        "exempt generated output",
        "-m",
        "Floor-waiver: new-exemption .constraintsignore -- generated output reviewed against source",
      ]);
      writeFileSync(join(dir, "src", "b.ts"), "export const y = 2;\n");
      git(["add", "."]);
      git(["commit", "-qm", "plain follow-up"]);
      const guard = join(dirname(fileURLToPath(import.meta.url)), "floor-guard.mjs");
      const run = spawnSync("node", [guard, "--base", base], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(run.status, 0, "non-tip new-exemption waiver covers the addition");
      assert.match(run.stdout, /Floor-waiver: new-exemption \.constraintsignore/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches a git-moved test file end to end", () => {
    // Real `git mv` output uses rename headers (no ---/+++ for a 100% move),
    // so this pins the parser against actual git output, not just fixtures.
    const dir = mkdtempSync(join(tmpdir(), "floor-guard-rename-"));
    try {
      const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "a.test.ts"), 'it("x", () => {\n expect(1).toBe(1);\n});\n');
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]).stdout.trim();
      mkdirSync(join(dir, "docs"), { recursive: true });
      git(["mv", "test/a.test.ts", "docs/a.txt"]);
      git(["commit", "-qm", "move test out of suite"]);
      const guard = join(dirname(fileURLToPath(import.meta.url)), "floor-guard.mjs");
      const bad = spawnSync("node", [guard, "--base", base], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(bad.status, 1, "moved-out test fails");
      assert.match(bad.stderr, /test-deleted/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
