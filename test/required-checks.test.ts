import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A required check whose workflow never starts leaves the PR pending forever,
// and a skipped job counts as passing. These pins keep CONTRIBUTING, the job
// names the rulesets match on, the unfiltered pull_request triggers and the
// aggregator guards (which run unless their own run was cancelled) in agreement.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
const required = ["ci-ok", "gitleaks", "e2e-ok", "pr-lint"];
const triggers = (text: string) => text.split(/\non:\n/)[1]?.split(/\n\S/)[0] ?? "";
// Children of the pull_request trigger: filters (paths, branches) live here.
const pullRequestBlock = (text: string) =>
  triggers(text).match(/(?:^|\n)  pull_request:[^\n]*((?:\n {4,}[^\n]*)*)/)?.[1] ?? "";
const job = (text: string, id: string) =>
  text.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";

describe("required checks always report", () => {
  it("CONTRIBUTING names exactly the checks the rulesets require", () => {
    const section =
      readFileSync("CONTRIBUTING.md", "utf8")
        .split("### Branch protection and required checks")[1]
        ?.split(/\n#{2,3} /)[0] ?? "";
    // Each bullet is "`ruleset`: ... `check` ... must pass."; drop the ruleset name.
    const named = section
      .split(/\n- /)
      .slice(1)
      .flatMap((bullet) =>
        [...(bullet.split("\n\n")[0] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]).slice(1),
      );
    expect(named).toEqual(required);
  });

  it("AGENTS.md and README.md name the live required set, not the retired check triple", () => {
    for (const file of ["AGENTS.md", "README.md"]) {
      const text = readFileSync(file, "utf8");
      for (const context of required) {
        expect(text).toContain(`\`${context}\``);
      }
      // The retired "`check`, `gitleaks` and `pr-lint`" triple must not come back.
      expect(text).not.toMatch(/`check`, `gitleaks`/);
    }
  });

  it.each(required)(
    "%s is one job in a workflow with an unfiltered pull_request trigger",
    (context) => {
      const owners = workflows.filter(({ text }) =>
        new RegExp(`\\n    name: ${context}\\n`).test(text),
      );
      expect(owners.map(({ name }) => name)).toHaveLength(1);
      const text = owners[0]?.text ?? "";
      expect(triggers(text)).toMatch(/(^|\n)  pull_request:/);
      expect(pullRequestBlock(text)).not.toMatch(
        /\b(paths|paths-ignore|branches|branches-ignore):/,
      );
    },
  );

  it("check needs only scope so it starts with the heavy jobs, and ci-ok fails when the audit is not green", () => {
    const ci = readFileSync(join(dir, "ci.yml"), "utf8");
    const check = job(ci, "check");
    // Exactly [scope]: any heavier need re-serializes check behind that job,
    // which is what made merge-queue ci take ~26 minutes.
    const needs = check.match(/\n    needs: \[([^\]]*)\]\n/)?.[1]?.split(/,\s*/) ?? [];
    expect(needs).toEqual(["scope"]);
    expect(check).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
    expect(job(ci, "ci-ok")).toContain('run: test "$A11Y_RESULT" = success');
  });

  it("documents ci-ok as the result gate for accessibility and performance", () => {
    const performance = readFileSync("docs/performance-budgets.md", "utf8");
    const accessibility = readFileSync("docs/a11y-ci.md", "utf8");
    for (const doc of [performance, accessibility]) {
      expect(doc).toMatch(/required\s+`ci-ok` job/);
      expect(doc).toContain("standalone `check`");
    }
    expect(performance).toMatch(/both `lighthouse` and `bundle-budget`\s+must succeed/);
    expect(performance).toContain("fails `ci-ok`");
    expect(accessibility).toMatch(/fails\s+`ci-ok`/);
    expect(performance).not.toMatch(/required `check` job depends on \*\*both\*\*/);
    expect(accessibility).not.toMatch(/required `check` job/);
  });

  it("gitleaks scans even when pr-lint failed", () => {
    const gitleaks = job(readFileSync(join(dir, "pr-gates.yml"), "utf8"), "gitleaks");
    expect(gitleaks).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
  });

  it("ci-ok aggregates the gated jobs", () => {
    const ci = readFileSync(join(dir, "ci.yml"), "utf8");
    const ok = job(ci, "ci-ok");
    expect(ok).toMatch(
      /\n    needs: \[a11y, lighthouse, bundle-budget, docs-links, check, node22-compat, scope\]\n/,
    );
    expect(ok).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
    // ci-ok is required (ruleset protect-main); the change-gating section documents what it aggregates.
    expect(readFileSync("CONTRIBUTING.md", "utf8")).toContain("### Change-gated CI and `ci-ok`");
  });

  // package.json declares `^22.23.0 || >=24` (22.23.0 is the 22.x floor
  // verified end to end against this repo's suite and lockfile); the 24
  // jobs alone ship the 22 range to developers unverified. The compat leg
  // pins the exact engines floor and ci-ok fails unless it succeeded, so
  // the leg cannot silently drift to a newer 22.x or report skipped.
  it("node22-compat runs lint, typecheck and unit tests on the exact Node 22.23.0 floor", () => {
    const ci = readFileSync(join(dir, "ci.yml"), "utf8");
    const leg = job(ci, "node22-compat");
    expect(leg).toContain("name: node22-compat");
    expect(leg).toMatch(/\n    needs: \[scope\]\n/);
    expect(leg).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
    expect(leg).toContain("image: node:22.23.0-bookworm");
    expect(leg).toMatch(/node-version: 22\.23\.0\n/);
    expect(leg).toContain('test "$(node --version)" = "v22.23.0"');
    expect(leg).toContain("npm run lint && npm run typecheck && npm test");
    // Like `check`, the leg always reports: its first step fails on a red
    // scope, and docs-only or draft PRs fast-pass instead of skipping.
    const steps = leg.split("\n    steps:\n")[1] ?? "";
    expect(steps).toMatch(/^      - name: Require successful scope\n/);
    expect(leg).toContain(
      "needs.scope.outputs.docs_only == 'true' || needs.scope.outputs.draft == 'true'",
    );
    expect(leg).toContain("needs.scope.outputs.draft != 'true'");
    expect(job(ci, "ci-ok")).toContain("Require successful Node 22 compatibility leg");
  });
});
