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

  it("flags added conditional skip forms", () => {
    // Fixture gated calls are built by concatenation, like the skip fixtures
    // above, so this file's own added lines never match the guard.
    const dot = ".";
    const skipProp = "sk" + "ip:";
    const forms = [
      ["test/a.test.ts", `describe${dot}${"skip" + "If"}(!db)("x", () => {});`],
      ["test/a.test.ts", `it${dot}${"run" + "If"}(db)("x", () => {});`],
      ["test/a.test.ts", `it("x", { ${skipProp} !db }, () => {});`],
      ["test/a.test.ts", `const suite = db ? describe : describe${dot}${"skip"};`],
      ["test/a.test.ts", `const suite = db ? describe${dot}${"skip"} : describe;`],
      ["test/a.test.ts", `const suite = describe${dot}${"skip"};`],
      ["ci/test_example.py", `@pytest.mark${dot}${"skip" + "if"}(cond)`],
      ["ci/test_example.py", `pytestmark = pytest.mark${dot}${"skip" + "if"}(cond)`],
    ];
    for (const [file, form] of forms) {
      const findings = guardDiff(
        diff(`--- a/${file}\n+++ b/${file}\n@@ -1,0 +2 @@\n+` + form + "\n"),
      ).filter((f) => f.rule === "test-made-easier");
      assert.equal(findings.length, 1, form);
      assert.equal(findings[0].file, file, form);
      assert.equal(findings[0].text, form, form);
    }
  });

  it("flags a skip option on its own line under a test call", () => {
    const skipProp = "sk" + "ip:";
    const findings = guardDiff(
      diff(
        '--- a/ci/x.test.mjs\n+++ b/ci/x.test.mjs\n@@ -1,0 +3 @@\n+test("x", {\n+  ' +
          skipProp +
          " !db,\n+}, () => {});\n",
      ),
    ).filter((f) => f.rule === "test-made-easier");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, "ci/x.test.mjs");
    assert.equal(findings[0].text, `${skipProp} !db,`);
  });

  it("still flags a conditional skip added to the guard's own test file", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const ignore = loadIgnore(root);
    const gated = "+describe" + "." + "skip" + 'If(!db)("x", () => {});\n';
    const d = diff(
      "--- a/ci/floor-guard.test.mjs\n+++ b/ci/floor-guard.test.mjs\n@@ -1,0 +2 @@\n" + gated,
    );
    assert.ok(
      guardDiff(d, { ignore }).some((f) => f.rule === "test-made-easier"),
      "ignore covers suppressions and stubs, never conditional skips",
    );
  });

  it("stays silent when a conditional skip replaces one in the same file", () => {
    const dot = ".";
    const gatedOld = `describe${dot}${"skip" + "If"}(!db)("old", () => {});`;
    const gatedNew = `describe${dot}${"skip" + "If"}(!db)("new", () => {});`;
    const runGated = `describe${dot}${"run" + "If"}(db)("x", () => {});`;
    const optionGated = `describe("x", { ${"sk" + "ip:"} !db }, () => {});`;
    const ternary = `const suite = db ? describe : describe${dot}${"skip"};`;
    const plainSkip = `describe${dot}${"skip"}("x", () => {});`;
    const swaps = [
      [gatedOld, gatedNew],
      [gatedOld, runGated],
      [gatedOld, optionGated],
      [ternary, gatedNew],
      // Replacing an unconditional skip with a gated one tightens the bar:
      // the removed skip pairs against the added conditional form.
      [plainSkip, gatedNew],
    ];
    for (const [before, after] of swaps) {
      const findings = guardDiff(
        diff(
          "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1 +1 @@\n-" +
            before +
            "\n+" +
            after +
            "\n",
        ),
      ).filter((f) => f.rule === "test-made-easier");
      assert.deepEqual(findings, [], `${before} -> ${after}`);
    }
  });

  it("flags only the net increase in conditional skips in a file", () => {
    const dot = ".";
    const gated = (name) => `describe${dot}${"skip" + "If"}(!db)("${name}", () => {});`;
    const findings = guardDiff(
      diff(
        "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1 +1,2 @@\n-" +
          gated("old") +
          "\n+" +
          gated("new") +
          "\n+" +
          gated("extra") +
          "\n",
      ),
    ).filter((f) => f.rule === "test-made-easier");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, "test/a.test.ts");
    assert.equal(findings[0].text, gated("extra"));
  });

  it("does not pair conditional skips across files", () => {
    const dot = ".";
    const gated = `describe${dot}${"skip" + "If"}(!db)("x", () => {});`;
    const d = [
      "diff --git a/test/a.test.ts b/test/a.test.ts",
      "--- a/test/a.test.ts",
      "+++ b/test/a.test.ts",
      "@@ -1 +0,0 @@",
      `-${gated}`,
      "diff --git a/test/b.test.ts b/test/b.test.ts",
      "--- a/test/b.test.ts",
      "+++ b/test/b.test.ts",
      "@@ -1,0 +2 @@",
      `+${gated}`,
    ].join("\n");
    const findings = guardDiff(d).filter((f) => f.rule === "test-made-easier");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, "test/b.test.ts");
  });

  it("still flags a conditional skip replaced by an unconditional skip", () => {
    const dot = ".";
    const gated = `describe${dot}${"skip" + "If"}(!db)("x", () => {});`;
    const plainSkip = `describe${dot}${"skip"}("x", () => {});`;
    const findings = guardDiff(
      diff(
        "--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -1 +1 @@\n-" +
          gated +
          "\n+" +
          plainSkip +
          "\n",
      ),
    ).filter((f) => f.rule === "test-made-easier");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].text, plainSkip);
  });

  it("pairs a conditional skip swap in a renamed test at its destination", () => {
    const dot = ".";
    const gated = `describe${dot}${"skip" + "If"}(!db)("x", () => {});`;
    const optionGated = `describe("x", { ${"sk" + "ip:"} !db }, () => {});`;
    const swapped = [
      "diff --git a/test/a.test.ts b/test/unit/a.test.ts",
      "similarity index 90%",
      "rename from test/a.test.ts",
      "rename to test/unit/a.test.ts",
      "--- a/test/a.test.ts",
      "+++ b/test/unit/a.test.ts",
      "@@ -1 +1 @@",
      `-${gated}`,
      `+${optionGated}`,
    ].join("\n");
    assert.deepEqual(
      guardDiff(swapped).filter((f) => f.rule === "test-made-easier"),
      [],
    );
  });

  it("does not flag skip data, prose, or non-test code", () => {
    const dot = ".";
    const skipProp = "sk" + "ip:";
    const cases = [
      [
        "ci/a11y-policy.test.mjs",
        `const coverage = { "/health": { ${skipProp} true, reason: "json" } };`,
      ],
      ["test/a.test.ts", `// test${dot}${"skip"} records the reason in the report.`],
      ["src/a.ts", `foo${dot}${"skip" + "If"}(x);`],
    ];
    for (const [file, line] of cases) {
      const findings = guardDiff(
        diff(`--- a/${file}\n+++ b/${file}\n@@ -1,0 +2 @@\n+` + line + "\n"),
      ).filter((f) => f.rule === "test-made-easier");
      assert.deepEqual(findings, [], line);
    }
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

  it("flags a Tier-0 suite moved out of its report-only runner", () => {
    // tier0/ runs only through tier0/vitest.config.ts, so docs/ or a
    // non-test suffix unwires the suite even though the name still matches
    // the test pattern.
    for (const dest of ["docs/a.test.ts", "tier0/a.test.ts.disabled"]) {
      const renamed = [
        `diff --git a/tier0/a.test.ts b/${dest}`,
        "similarity index 100%",
        "rename from tier0/a.test.ts",
        `rename to ${dest}`,
      ].join("\n");
      assert.ok(
        guardDiff(renamed).some((f) => f.rule === "test-deleted"),
        `${dest} leaves the Tier-0 runner and needs a test-deleted waiver`,
      );
    }
  });

  it("flags a move across the blocking/report-only boundary either way", () => {
    // test/ runs inside the blocking coverage step while tier0/ is
    // report-only: crossing the boundary changes what gates the suite, so
    // both directions need a test-deleted waiver.
    for (const [from, to] of [
      ["tier0/a.test.ts", "test/a.test.ts"],
      ["test/a.test.ts", "tier0/a.test.ts"],
    ]) {
      const renamed = [
        `diff --git a/${from} b/${to}`,
        "similarity index 100%",
        `rename from ${from}`,
        `rename to ${to}`,
      ].join("\n");
      assert.ok(
        guardDiff(renamed).some((f) => f.rule === "test-deleted"),
        `${from} to ${to} crosses the blocking/report-only boundary`,
      );
    }
  });

  it("stays silent on a Tier-0 rename inside its runner", () => {
    const kept = [
      "diff --git a/tier0/a.test.ts b/tier0/nested/a.test.ts",
      "similarity index 100%",
      "rename from tier0/a.test.ts",
      "rename to tier0/nested/a.test.ts",
    ].join("\n");
    assert.deepEqual(guardDiff(kept), []);
  });

  it("flags e2e spec and safety renames out of the runner", () => {
    // Each runner branch needs its own pin: a mutant returning true for one
    // branch must fail. Specs run under testDir ./e2e, so docs/ is out; the
    // safety .txt destination matches no runner at all.
    for (const [from, to] of [
      ["e2e/a.spec.ts", "docs/a.spec.ts"],
      ["e2e/x.test.mjs", "e2e/x.txt"],
    ]) {
      const renamed = [
        `diff --git a/${from} b/${to}`,
        "similarity index 100%",
        `rename from ${from}`,
        `rename to ${to}`,
      ].join("\n");
      assert.ok(
        guardDiff(renamed).some((f) => f.rule === "test-deleted"),
        `${from} -> ${to} needs a test-deleted waiver`,
      );
    }
  });

  it("flags ci selftest renames out of the wiring", () => {
    // A move out of ci/ or a suffix change breaks the explicit wiring even
    // though the name still matches the test pattern.
    for (const to of ["docs/x-selftest.mjs", "ci/x-selftest.cjs"]) {
      const renamed = [
        "diff --git a/ci/x-selftest.mjs b/" + to,
        "similarity index 100%",
        "rename from ci/x-selftest.mjs",
        `rename to ${to}`,
      ].join("\n");
      assert.ok(
        guardDiff(renamed).some((f) => f.rule === "test-deleted"),
        `ci/x-selftest.mjs -> ${to} needs a test-deleted waiver`,
      );
    }
  });

  it("flags enumerated-runner renames that keep the same pattern", () => {
    // `node --test a b` silently skips a missing path and exits 0, so a
    // rename that keeps the pattern still drops tests: e2e:safety falls from
    // 80 to 66 passing tests, and ci/policy drops out of the a11y glob. The
    // vitest-run audit lifecycle suite is named exactly by the a11y job, so
    // any rename of it breaks the wiring too.
    for (const [from, to] of [
      ["e2e/qa-request.test.mjs", "e2e/qa-request2.test.mjs"],
      ["ci/a11y-policy.test.mjs", "ci/policy.test.mjs"],
      ["ci/audit-lifecycle.test.mjs", "ci/audit-lifecycle-renamed.test.mjs"],
      ["ci/cutover-check-selftest.mjs", "ci/cutover-renamed-selftest.mjs"],
    ]) {
      const renamed = [
        `diff --git a/${from} b/${to}`,
        "similarity index 100%",
        `rename from ${from}`,
        `rename to ${to}`,
      ].join("\n");
      assert.ok(
        guardDiff(renamed).some((f) => f.rule === "test-deleted"),
        `${from} -> ${to} breaks enumerated wiring and needs a waiver`,
      );
    }
  });

  it("stays silent on an a11y rename within the glob", () => {
    // ci/a11y-*.test.mjs runs via shell glob, so a rename that keeps the
    // glob keeps running.
    const renamed = [
      "diff --git a/ci/a11y-policy.test.mjs b/ci/a11y-renamed.test.mjs",
      "similarity index 100%",
      "rename from ci/a11y-policy.test.mjs",
      "rename to ci/a11y-renamed.test.mjs",
    ].join("\n");
    assert.deepEqual(
      guardDiff(renamed).filter((f) => f.rule === "test-deleted"),
      [],
    );
  });

  it("clears a renamed-test strip only with a waiver on the old path", () => {
    // Removed lines carry the destination as pairing key and the origin
    // separately; the waiver lookup and finding label read the origin.
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
    assert.ok(findings.some((f) => f.rule === "assertion-removed"));
    assert.equal(
      findings.find((f) => f.rule === "assertion-removed").file,
      "test/a.test.ts",
      "finding names the origin path",
    );
    const oldWaiver = parseFloorWaivers(
      "move suite\n\nFloor-waiver: assertion-removed test/a.test.ts -- assertions moved with the file\n",
    );
    assert.deepEqual(
      guardDiff(stripped, { waivers: oldWaiver }).filter((f) => f.rule === "assertion-removed"),
      [],
      "waiver on the old path clears the strip",
    );
    const newWaiver = parseFloorWaivers(
      "move suite\n\nFloor-waiver: assertion-removed test/unit/a.test.ts -- assertions moved with the file\n",
    );
    assert.ok(
      guardDiff(stripped, { waivers: newWaiver }).some((f) => f.rule === "assertion-removed"),
      "waiver on the new path must not clear the strip",
    );
  });

  it("flags a CONSTRAINTS.md move that lowers a threshold", () => {
    // Removed rows read the origin, so a move to another name leaves the
    // rows unpaired and they flag as threshold-removed; the finding names
    // the origin so the waiver target is clear.
    const moved = [
      "diff --git a/CONSTRAINTS.md b/docs/QUALITY.md",
      "similarity index 90%",
      "rename from CONSTRAINTS.md",
      "rename to docs/QUALITY.md",
      "--- a/CONSTRAINTS.md",
      "+++ b/docs/QUALITY.md",
      "@@ -1 +1 @@",
      "-| Coverage of changed lines | Added TS lines ≥ 80% executed | `npm run patch:coverage` | CI |",
      "+| Coverage of changed lines | Added TS lines ≥ 50% executed | `npm run patch:coverage` | CI |",
    ].join("\n");
    const findings = guardDiff(moved);
    assert.ok(
      findings.some((f) => f.rule === "threshold-removed"),
      "moved-and-lowered threshold needs a waiver",
    );
    assert.equal(findings.find((f) => f.rule === "threshold-removed").file, "CONSTRAINTS.md");
  });

  it("flags a pure CONSTRAINTS.md move as a threshold removal", () => {
    // A 100% rename carries no hunks, so no threshold row is ever examined:
    // leaving the CONSTRAINTS.md name blinds every later CONSTRAINTS check,
    // so the move flags threshold-removed like a deletion.
    const moved = [
      "diff --git a/CONSTRAINTS.md b/docs/QUALITY.md",
      "similarity index 100%",
      "rename from CONSTRAINTS.md",
      "rename to docs/QUALITY.md",
    ].join("\n");
    const findings = guardDiff(moved);
    assert.ok(
      findings.some((f) => f.rule === "threshold-removed" && f.file === "CONSTRAINTS.md"),
      "pure move of the floor file needs a waiver",
    );
    const waived = parseFloorWaivers(
      "move thresholds\n\nFloor-waiver: threshold-removed CONSTRAINTS.md -- thresholds moved to docs/QUALITY.md\n",
    );
    assert.deepEqual(
      guardDiff(moved, { waivers: waived }).filter((f) => f.rule === "threshold-removed"),
      [],
    );
  });

  it("flags a deleted CONSTRAINTS.md as a threshold removal", () => {
    // A deleted file's hunks carry file "" so per-row checks never see them;
    // the path only lands in deletedFiles, which flags threshold-removed.
    const d = [
      "diff --git a/CONSTRAINTS.md b/CONSTRAINTS.md",
      "deleted file mode 100644",
      "--- a/CONSTRAINTS.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-| Coverage of changed lines | Added TS lines ≥ 80% executed | `npm run patch:coverage` | CI |",
    ].join("\n");
    assert.ok(
      guardDiff(d).some((f) => f.rule === "threshold-removed"),
      "deleting CONSTRAINTS.md removes the whole bar",
    );
    const waived = parseFloorWaivers(
      "move thresholds\n\nFloor-waiver: threshold-removed CONSTRAINTS.md -- thresholds moved to docs/QUALITY.md\n",
    );
    assert.deepEqual(
      guardDiff(d, { waivers: waived }).filter((f) => f.rule === "threshold-removed"),
      [],
    );
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

  it("unfolds adjacent wrapped waivers without joining them together", () => {
    const waivers = parseFloorWaivers(
      [
        "Floor-waiver: test-deleted test/first.test.ts",
        "-- moved to docs",
        "Floor-waiver: assertion-removed test/second.test.ts",
        "-- assertion moved to the replacement suite",
        "Floor-waiver: test-deleted test/staging-workflow-secret-mapping.test.ts",
        "-- moved to docs",
      ].join("\n"),
    );
    assert.deepEqual(
      [...waivers.get("test-deleted")],
      ["test/first.test.ts", "test/staging-workflow-secret-mapping.test.ts"],
    );
    assert.deepEqual([...waivers.get("assertion-removed")], ["test/second.test.ts"]);
  });

  it("removes wrap-inserted spaces from a path split mid-word", () => {
    const waivers = parseFloorWaivers(
      "Floor-waiver: test-deleted test/staging-workflow-sec\nret-mapping.test.ts -- moved to docs",
    );
    assert.deepEqual(
      [...waivers.get("test-deleted")],
      ["test/staging-workflow-secret-mapping.test.ts"],
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

  it("accepts queue squash body waivers for a renamed test but still rejects an unwaived deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "floor-guard-merge-group-"));
    try {
      const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "a.test.ts"), 'it("x", () => { expect(1).toBe(1); });\n');
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]).stdout.trim();
      mkdirSync(join(dir, "docs"), { recursive: true });
      git(["mv", "test/a.test.ts", "docs/a.txt"]);
      const waiver =
        "Floor-waiver: test-deleted test/a.test.ts -- moved into docs as documentation";
      git(["commit", "-m", "move test out of suite", "-m", waiver]);
      const guard = join(dirname(fileURLToPath(import.meta.url)), "floor-guard.mjs");
      const run = () => spawnSync("node", [guard, "--base", base], { cwd: dir, encoding: "utf8" });
      const branch = run();
      assert.equal(branch.status, 0, branch.stderr);
      assert.match(branch.stdout, /Floor-waiver: test-deleted test\/a\.test\.ts/);

      // Merge-queue validation sees one squash commit, not the waiver-bearing
      // branch commit. Its message is the PR title plus body.
      git(["reset", "--soft", base]);
      git(["commit", "-qm", "test: move test", "-m", "PR body without waiver"]);
      const unwaived = run();
      assert.equal(unwaived.status, 1, "the squash without a waiver fails");
      assert.match(unwaived.stderr, /test-deleted/);

      git(["commit", "--amend", "-qm", "test: move test", "-m", "PR body", "-m", waiver]);
      const waived = run();
      assert.equal(waived.status, 0, waived.stderr);
      assert.match(waived.stdout, /Floor-waiver: test-deleted test\/a\.test\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a 72-column wrapped queue waiver for a long path", () => {
    // The queue squash hard-wraps the body, so a long trailer arrives split
    // across lines. The guard must unfold it, or pr-lint stays green while
    // the queue fails. Uses the reviewer repro path.
    const dir = mkdtempSync(join(tmpdir(), "floor-guard-wrapped-"));
    try {
      const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(
        join(dir, "test", "staging-workflow-secret-mapping.test.ts"),
        'it("x", () => { expect(1).toBe(1); });\n',
      );
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]).stdout.trim();
      mkdirSync(join(dir, "docs"), { recursive: true });
      git(["mv", "test/staging-workflow-secret-mapping.test.ts", "docs/mapping.txt"]);
      const waiver =
        "Floor-waiver: test-deleted test/staging-workflow-secret-mapping.test.ts -- moved to docs";
      git(["commit", "-m", "move long test out of suite", "-m", waiver]);
      const guard = join(dirname(fileURLToPath(import.meta.url)), "floor-guard.mjs");
      const run = () => spawnSync("node", [guard, "--base", base], { cwd: dir, encoding: "utf8" });
      const branch = run();
      assert.equal(branch.status, 0, branch.stderr);

      // Queue squash: same body wrapped at 72 columns (word wrap), so the
      // trailer splits before `--`.
      const wrapped = [
        "Floor-waiver: test-deleted test/staging-workflow-secret-mapping.test.ts",
        "-- moved to docs",
      ].join("\n");
      git(["reset", "--soft", base]);
      git(["commit", "-qm", "test: move test", "-m", "PR body", "-m", wrapped]);
      const waived = run();
      assert.equal(waived.status, 0, waived.stderr);
      assert.match(
        waived.stdout,
        /Floor-waiver: test-deleted test\/staging-workflow-secret-mapping\.test\.ts/,
      );
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
