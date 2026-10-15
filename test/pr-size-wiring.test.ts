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

describe("pr-size advisory wiring", () => {
  it("is not a required check", () => {
    const branchProtection =
      contributing.split("### Branch protection and required checks")[1]?.split(/\n#{2,3} /)[0] ??
      "";
    expect(branchProtection).not.toContain("pr-size");
  });

  it("grants write scopes only to the labelling job", () => {
    const topLevel = workflow.split(/\npermissions:\n/)[1]?.split(/\n\S/)[0] ?? "";
    expect(topLevel).not.toMatch(/\bwrite\b/);
    expect(job("pr-size")).toContain("      issues: write\n");
    expect(job("pr-size")).toContain("      pull-requests: write\n");
    expect(job("pr-size-weekly")).not.toMatch(/\bwrite\b/);
  });

  it("calls the central reusables at one pinned full SHA", () => {
    const labelPin = job("pr-size").match(
      new RegExp(`uses: ${CENTRAL.replaceAll(".", "\\.")}/pr-size\\.yml@([0-9a-f]{40})`),
    )?.[1];
    const weeklyPin = job("pr-size-weekly").match(
      new RegExp(`uses: ${CENTRAL.replaceAll(".", "\\.")}/pr-size-weekly\\.yml@([0-9a-f]{40})`),
    )?.[1];
    expect(labelPin).toBeTruthy();
    expect(weeklyPin).toBe(labelPin);
    // No floating refs, no other reusable calls, no secrets passthrough:
    // the caller token stays capped by the job grants above.
    expect(workflow.match(/\n    uses: /g)).toHaveLength(2);
    expect(workflow).not.toContain("secrets:");
  });

  it("keeps no local labeller copy and sets no local threshold", () => {
    expect(existsSync(".github/scripts/pr_size.py")).toBe(false);
    expect(existsSync(".github/scripts/test_pr_size.py")).toBe(false);
    expect(workflow).not.toContain("PR_SIZE_THRESHOLD");
    expect(workflow).not.toContain("python3");
  });

  it("excludes this repo's generated paths but keeps hand-written SQL counted", () => {
    const extra = job("pr-size").match(/exclude-extra: "([^"]*)"/)?.[1] ?? "";
    expect(extra.split(",")).toContain("public/islands/**");
    expect(extra.split(",")).toContain("public/styles.css");
    expect(extra.split(",")).toContain("drizzle/meta/**");
    expect(extra).not.toContain("drizzle/*.sql");
    expect(extra.split(",")).not.toContain("drizzle/**");
  });

  it("keeps the Monday weekly tally schedule in the caller", () => {
    expect(workflow).toMatch(/\n  schedule:\n    - cron: '17 7 \* \* 1'\n/);
  });
});
