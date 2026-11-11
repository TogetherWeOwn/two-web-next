import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The PR-size labeller is advisory only: these pins keep it that way. The
// advisory job names must never join the required set; `pr-size-gate` is the
// one deliberate required exception and must name the gate reusable. The
// write scopes stay on the two caller jobs that need them (never
// workflow-wide, never the weekly job). All labelling logic lives once in
// the org `.github` repository and runs from there at a pinned SHA, so this
// repo keeps no script copy a pull request could modify or delete to silence
// its own label; behaviour is tested centrally next to the script.
const workflow = readFileSync(".github/workflows/pr-size.yml", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const job = (id: string) =>
  workflow.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";
const CENTRAL = "TogetherWeOwn/.github/.github/workflows";
const REVIEWED_CENTRAL_SHA = "ac9ce8d63e0cebd19ede904ac79137190c329964";

describe("pr-size advisory wiring", () => {
  it("keeps the advisory jobs out of the required set and names the required gate", () => {
    const branchProtection = contributing
      .split("### Branch protection and required checks")[1]
      ?.split(/\n#{2,3} /)[0];
    expect(branchProtection).toBeTruthy();
    expect(branchProtection).toContain("`ci-ok`");
    expect(branchProtection).toContain("`pr-size-gate`");
    expect(branchProtection).not.toContain("`pr-size`");
  });

  it("grants write scopes only to the labelling and gate jobs", () => {
    expect(workflow.match(/^permissions:/gm)).toHaveLength(1);
    const topLevel = workflow.match(/^permissions:\n([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9_-]*:)/m)?.[1];
    expect(topLevel?.trim()).toBe("contents: read");
    for (const id of ["pr-size", "pr-size-gate"]) {
      const callerJob = job(id);
      expect(callerJob.match(/^    permissions:/gm)).toHaveLength(1);
      const callerPermissions = callerJob.match(
        /^    permissions:\n([\s\S]*?)(?=^    [A-Za-z][A-Za-z0-9_-]*:)/m,
      )?.[1];
      expect(callerPermissions?.trimEnd()).toBe(
        "      contents: read\n      issues: write\n      pull-requests: write",
      );
    }
    expect(job("pr-size-weekly")).not.toMatch(/\bwrite\b/);
    // Fail closed on any added job or write scope beyond the two callers'.
    const jobsText = workflow.split("\njobs:\n")[1] ?? "";
    expect([...jobsText.matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map((m) => m[1])).toEqual([
      "pr-size",
      "pr-size-gate",
      "pr-size-weekly",
    ]);
    expect(workflow.match(/\bwrite\b/g)).toHaveLength(4);
  });

  it("calls the central reusables at one pinned full SHA", () => {
    const labelPin = job("pr-size").match(
      new RegExp(`uses: ${CENTRAL.replaceAll(".", "\\.")}/pr-size\\.yml@([0-9a-f]{40})`),
    )?.[1];
    const gatePin = job("pr-size-gate").match(
      new RegExp(`uses: ${CENTRAL.replaceAll(".", "\\.")}/pr-size-gate\\.yml@([0-9a-f]{40})`),
    )?.[1];
    const weeklyPin = job("pr-size-weekly").match(
      new RegExp(`uses: ${CENTRAL.replaceAll(".", "\\.")}/pr-size-weekly\\.yml@([0-9a-f]{40})`),
    )?.[1];
    expect(labelPin).toBeTruthy();
    expect(labelPin).toBe(REVIEWED_CENTRAL_SHA);
    expect(gatePin).toBe(REVIEWED_CENTRAL_SHA);
    expect(weeklyPin).toBe(REVIEWED_CENTRAL_SHA);
    expect(gatePin).toBe(labelPin);
    expect(weeklyPin).toBe(labelPin);
    // No floating refs, no other reusable calls, no secrets passthrough:
    // the caller token stays capped by the job grants above.
    expect(workflow.match(/\n    uses: /g)).toHaveLength(3);
    expect(workflow).not.toMatch(/secrets\s*:/);
    // The gate re-evaluates when an exception is granted or revoked and
    // when a review is submitted or dismissed.
    expect(workflow).toContain("labeled, unlabeled");
    expect(workflow).toContain("pull_request_review:");
  });

  it("keeps no local labeller copy and sets no local threshold", () => {
    expect(existsSync(".github/scripts/pr_size.py")).toBe(false);
    expect(existsSync(".github/scripts/test_pr_size.py")).toBe(false);
    expect(workflow).not.toContain("PR_SIZE_THRESHOLD");
    expect(workflow).not.toContain("python3");
  });

  it("excludes this repo's generated paths but keeps hand-written SQL counted", () => {
    for (const id of ["pr-size", "pr-size-gate"]) {
      const callerJob = job(id);
      expect(callerJob.match(/^      exclude-extra:/gm)).toHaveLength(1);
      const extra = callerJob.match(/^      exclude-extra: "([^"]*)"$/m)?.[1] ?? "";
      expect(extra).toBe("public/islands/**,public/styles.css,drizzle/meta/**");
      expect(extra).not.toContain("drizzle/*.sql");
      expect(extra.split(",")).not.toContain("drizzle/**");
    }
  });

  it("keeps the Monday weekly tally schedule in the caller", () => {
    expect(workflow).toMatch(/\n  schedule:\n    - cron: (["'])17 7 \* \* 1\1\n/);
  });
});
