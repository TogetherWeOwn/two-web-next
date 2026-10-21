import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The PR-size labeller is advisory only: these pins keep it that way. Its job
// names must never join the required set, and the write scopes stay on the
// one caller job that labels (never workflow-wide, never the weekly job).
// All labelling logic lives once in the org `.github` repository and runs
// from there at a pinned SHA, so this repo keeps no script copy a pull
// request could modify or delete to silence its own label; behaviour is
// tested centrally next to the script.
const workflow = readFileSync(".github/workflows/pr-size.yml", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const job = (id: string) =>
  workflow.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";
const CENTRAL = "TogetherWeOwn/.github/.github/workflows";
const REVIEWED_CENTRAL_SHA = "82c5b367c6e3e8032666029dc22d206fff39c3f2";

describe("pr-size advisory wiring", () => {
  it("is not a required check", () => {
    const branchProtection = contributing
      .split("### Branch protection and required checks")[1]
      ?.split(/\n#{2,3} /)[0];
    expect(branchProtection).toBeTruthy();
    expect(branchProtection).toContain("`ci-ok`");
    expect(branchProtection).not.toContain("pr-size");
  });

  it("grants write scopes only to the labelling job", () => {
    expect(workflow.match(/^permissions:/gm)).toHaveLength(1);
    const topLevel = workflow.match(/^permissions:\n([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9_-]*:)/m)?.[1];
    expect(topLevel?.trim()).toBe("contents: read");
    const labelJob = job("pr-size");
    expect(labelJob.match(/^    permissions:/gm)).toHaveLength(1);
    const labelPermissions = labelJob.match(
      /^    permissions:\n([\s\S]*?)(?=^    [A-Za-z][A-Za-z0-9_-]*:)/m,
    )?.[1];
    expect(labelPermissions?.trimEnd()).toBe(
      "      contents: read\n      issues: write\n      pull-requests: write",
    );
    expect(job("pr-size")).toContain("      issues: write\n");
    expect(job("pr-size")).toContain("      pull-requests: write\n");
    expect(job("pr-size-weekly")).not.toMatch(/\bwrite\b/);
    // Fail closed on any added job or write scope beyond the label job's two.
    const jobsText = workflow.split("\njobs:\n")[1] ?? "";
    expect([...jobsText.matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map((m) => m[1])).toEqual([
      "pr-size",
      "pr-size-weekly",
    ]);
    expect(workflow.match(/\bwrite\b/g)).toHaveLength(2);
  });

  it("calls the central reusables at one pinned full SHA", () => {
    const labelPin = job("pr-size").match(
      new RegExp(`uses: ${CENTRAL.replaceAll(".", "\\.")}/pr-size\\.yml@([0-9a-f]{40})`),
    )?.[1];
    const weeklyPin = job("pr-size-weekly").match(
      new RegExp(`uses: ${CENTRAL.replaceAll(".", "\\.")}/pr-size-weekly\\.yml@([0-9a-f]{40})`),
    )?.[1];
    expect(labelPin).toBeTruthy();
    expect(labelPin).toBe(REVIEWED_CENTRAL_SHA);
    expect(weeklyPin).toBe(REVIEWED_CENTRAL_SHA);
    expect(weeklyPin).toBe(labelPin);
    // No floating refs, no other reusable calls, no secrets passthrough:
    // the caller token stays capped by the job grants above.
    expect(workflow.match(/\n    uses: /g)).toHaveLength(2);
    expect(workflow).not.toMatch(/secrets\s*:/);
  });

  it("keeps no local labeller copy and sets no local threshold", () => {
    expect(existsSync(".github/scripts/pr_size.py")).toBe(false);
    expect(existsSync(".github/scripts/test_pr_size.py")).toBe(false);
    expect(workflow).not.toContain("PR_SIZE_THRESHOLD");
    expect(workflow).not.toContain("python3");
  });

  it("excludes this repo's generated paths but keeps hand-written SQL counted", () => {
    const labelJob = job("pr-size");
    expect(labelJob.match(/^      exclude-extra:/gm)).toHaveLength(1);
    const extra = labelJob.match(/exclude-extra: "([^"]*)"/)?.[1] ?? "";
    expect(extra).toBe(
      "public/islands/**,public/styles.css,public/admin-terminal-review.css,drizzle/meta/**",
    );
    expect(extra).not.toContain("drizzle/*.sql");
    expect(extra.split(",")).not.toContain("drizzle/**");
  });

  it("keeps the Monday weekly tally schedule in the caller", () => {
    expect(workflow).toMatch(/\n  schedule:\n    - cron: '17 7 \* \* 1'\n/);
  });
});
