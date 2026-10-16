import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Acceptance pins for the check-parallel workflow change (PR #920).
//
// End state under test:
// - `check` needs only `scope`, so it starts alongside the audit and
//   performance jobs instead of serializing behind them.
// - The result gates that used to sit in `check` (docs-links, the
//   accessibility audit, the lighthouse + bundle-budget performance gate)
//   live in the required `ci-ok` aggregator, which already needs every one
//   of those jobs.
// - This file is test-only: it reads `.github/workflows/ci.yml` and
//   executes the extracted guard snippets. It never edits the workflow.
//
// Failing-first proof: on the pre-change workflow every `needs` pin below
// fails (check waits on the heavy jobs, ci-ok lacks docs-links) and the
// guard-location asserts fail (guards sit in check, not ci-ok).

const readWorkflow = () => readFileSync(".github/workflows/ci.yml", "utf8");

const jobBlock = (text: string, id: string) =>
  text.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";

const PERFORMANCE_CONDITION =
  "always() && (needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true') && (needs.scope.outputs.full == 'true' || needs.scope.outputs.app == 'true')";

describe("check-parallel acceptance", () => {
  it("check needs only scope so it starts with the heavy jobs", () => {
    const check = jobBlock(readWorkflow(), "check");
    expect(check).toMatch(/\n    needs: \[scope\]\n/);
    expect(check).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
  });

  it("check no longer gates the docs-links result", () => {
    const check = jobBlock(readWorkflow(), "check");
    expect(check).not.toContain('run: test "$DOCS_LINKS_RESULT" = success');
  });

  it("check no longer gates the accessibility audit result", () => {
    const check = jobBlock(readWorkflow(), "check");
    expect(check).not.toContain('run: test "$A11Y_RESULT" = success');
  });

  it("check no longer runs the lighthouse + bundle-budget performance gate", () => {
    const check = jobBlock(readWorkflow(), "check");
    expect(check).not.toContain(
      'node ci/require-performance.mjs "${{ needs.lighthouse.result }}" "${{ needs.bundle-budget.result }}"',
    );
    // The gate's selftest stays in check so the script itself stays pinned.
    expect(check).toContain("run: node ci/require-performance.mjs --selftest");
  });

  it("ci-ok needs every gated job including docs-links", () => {
    const ok = jobBlock(readWorkflow(), "ci-ok");
    expect(ok).toMatch(
      /\n    needs: \[a11y, lighthouse, bundle-budget, docs-links, check, scope\]\n/,
    );
    expect(ok).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
  });

  it("ci-ok fails unless docs-links passes", () => {
    const ok = jobBlock(readWorkflow(), "ci-ok");
    const guard = ok.match(
      /- name: Require successful docs-links\n        env:\n          DOCS_LINKS_RESULT: \$\{\{ needs\.docs-links\.result \}\}\n        run: ([^\n]+)\n/,
    )?.[1];
    expect(guard, "docs-links guard must sit in ci-ok").toBeDefined();
    for (const [result, expected] of [
      ["success", 0],
      ["failure", 1],
      ["cancelled", 1],
      ["skipped", 1],
      ["", 1],
    ] as const) {
      const run = spawnSync("bash", ["-c", guard ?? "exit 99"], {
        env: { DOCS_LINKS_RESULT: result },
        encoding: "utf8",
      });
      expect(run.status, `docs-links result ${result || "missing"}`).toBe(expected);
    }
  });

  it("ci-ok fails when the selected accessibility audit is not green", () => {
    const ok = jobBlock(readWorkflow(), "ci-ok");
    const guard = ok.match(
      /- name: Require successful accessibility audit\n        if: \(needs\.scope\.outputs\.docs_only != 'true' && needs\.scope\.outputs\.draft != 'true'\)\n        env:\n          A11Y_RESULT: [^\n]+\n          A11Y_SELECTED: [^\n]+\n        run: ([^\n]+)/,
    )?.[1];
    expect(guard, "audit guard must sit in ci-ok").toBeDefined();
    for (const [result, selected, expected] of [
      ["success", "true", 0],
      ["success", "false", 0],
      ["failure", "true", 1],
      ["failure", "false", 1],
      ["cancelled", "true", 1],
      ["skipped", "true", 1],
      ["skipped", "false", 0],
    ] as const) {
      const run = spawnSync("bash", ["-c", guard ?? "exit 99"], {
        env: { A11Y_RESULT: result, A11Y_SELECTED: selected },
        encoding: "utf8",
      });
      expect(run.status, `a11y ${result} selected=${selected}`).toBe(expected);
    }
  });

  it("ci-ok runs the always-on performance gate over both performance results", () => {
    const workflow = readWorkflow();
    const ok = workflow.split("\n  ci-ok:\n")[1] ?? "";
    const marker = "\n      - name: Performance gate (lighthouse + bundle-budget must succeed)\n";
    const at = ok.indexOf(marker);
    expect(at, "performance gate must sit in ci-ok").toBeGreaterThan(-1);
    const gate = ok.slice(at + marker.length).split("\n      - name:")[0] ?? "";
    expect(gate).toContain(`if: ${PERFORMANCE_CONDITION}`);
    expect(gate).toContain(
      'run: node ci/require-performance.mjs "${{ needs.lighthouse.result }}" "${{ needs.bundle-budget.result }}"',
    );
    // The checkout + setup-node the gate reports through keep the same gate.
    const before = ok.slice(0, at);
    const checkout =
      before.split("\n      - uses: actions/checkout@")[1]?.split("\n      - ")[0] ?? "";
    const setupNode =
      before.split("\n      - uses: actions/setup-node@")[1]?.split("\n      - ")[0] ?? "";
    expect(checkout).toContain(`\n        if: ${PERFORMANCE_CONDITION}\n`);
    expect(setupNode).toContain(`\n        if: ${PERFORMANCE_CONDITION}\n`);
  });
});
