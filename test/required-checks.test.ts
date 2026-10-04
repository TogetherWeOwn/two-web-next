import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A required check whose workflow never starts leaves the PR pending forever,
// and a skipped job counts as passing. These pins keep CONTRIBUTING, the job
// names the rulesets match on, the unfiltered pull_request triggers and the
// always-run aggregator guards in agreement.
const dir = ".github/workflows";
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
const required = ["check", "gitleaks", "pr-lint"];
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

  it("check runs whatever its dependencies concluded and fails when the audit is not green", () => {
    const check = job(readFileSync(join(dir, "ci.yml"), "utf8"), "check");
    // More gates may join `needs`; the guard below only relies on these two.
    const needs = check.match(/\n    needs: \[([^\]]*)\]\n/)?.[1]?.split(/,\s*/) ?? [];
    expect(needs).toEqual(expect.arrayContaining(["a11y", "scope"]));
    expect(check).toMatch(/\n    if: always\(\)\n/);
    expect(check).toContain('run: test "$A11Y_RESULT" = success');
  });

  it("gitleaks scans even when pr-lint failed", () => {
    const gitleaks = job(readFileSync(join(dir, "pr-gates.yml"), "utf8"), "gitleaks");
    expect(gitleaks).toMatch(/\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
  });

  it("ci-ok aggregates the gated jobs but is not itself required yet", () => {
    const ci = readFileSync(join(dir, "ci.yml"), "utf8");
    const ok = job(ci, "ci-ok");
    expect(ok).toMatch(/\n    needs: \[a11y, lighthouse, bundle-budget, check, scope\]\n/);
    expect(ok).toMatch(/\n    if: always\(\)\n/);
    // The ruleset cutover is an OPERATOR step after merge + green probes, so
    // the required-check bullets above still name exactly check, gitleaks and
    // pr-lint — while the change-gating section below documents ci-ok.
    expect(readFileSync("CONTRIBUTING.md", "utf8")).toContain("### Change-gated CI and `ci-ok`");
  });
});
