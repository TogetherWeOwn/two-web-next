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

  it("check starts independently while ci-ok waits for check and both audits", () => {
    const ci = readFileSync(join(dir, "ci.yml"), "utf8");
    const check = job(ci, "check");
    const checkNeeds = check.match(/\n    needs: \[([^\]]*)\]\n/)?.[1]?.split(/,\s*/) ?? [];
    expect(checkNeeds).toEqual(["scope"]);
    expect(check).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);

    const ciOk = job(ci, "ci-ok");
    const ciOkNeeds = ciOk.match(/\n    needs: \[([^\]]*)\]\n/)?.[1]?.split(/,\s*/) ?? [];
    expect(ciOkNeeds).toEqual([
      "a11y",
      "lighthouse",
      "bundle-budget",
      "docs-links",
      "check",
      "scope",
    ]);
    expect(ciOk).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
    expect(ciOk).toContain("CHECK_RESULT: ${{ needs.check.result }}");
    expect(ciOk).toContain('fail "check did not succeed."');
  });

  it("gitleaks scans even when pr-lint failed", () => {
    const gitleaks = job(readFileSync(join(dir, "pr-gates.yml"), "utf8"), "gitleaks");
    expect(gitleaks).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
  });

  it("ci-ok aggregates the gated jobs", () => {
    const ci = readFileSync(join(dir, "ci.yml"), "utf8");
    const ok = job(ci, "ci-ok");
    expect(ok).toMatch(
      /\n    needs: \[a11y, lighthouse, bundle-budget, docs-links, check, scope\]\n/,
    );
    expect(ok).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
    // ci-ok is required (ruleset protect-main); the change-gating section documents what it aggregates.
    expect(readFileSync("CONTRIBUTING.md", "utf8")).toContain("### Change-gated CI and `ci-ok`");
  });
});
