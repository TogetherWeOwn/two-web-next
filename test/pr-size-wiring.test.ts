import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The PR-size labeller is advisory only: these pins keep it that way. Its job
// names must never join the required set, the write scopes stay on the one job
// that labels (never workflow-wide), and that job runs the base branch's copy
// of .github/scripts/pr_size.py so a pull request cannot run its own modified
// labeller under a write token. Behaviour lives in test_pr_size.py.
const workflow = readFileSync(".github/workflows/pr-size.yml", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const job = (id: string) =>
  workflow.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";

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

  it("runs the base branch's labeller, never the PR head's copy", () => {
    const labelJob = job("pr-size");
    expect(labelJob).toContain('git show "$base_sha:.github/scripts/pr_size.py"');
    expect(labelJob).toContain('python3 "$RUNNER_TEMP/pr_size.py" label');
    expect(labelJob).not.toContain("python3 .github/scripts/pr_size.py");
  });

  it("keeps the 400-line advisory threshold and the weekly tally", () => {
    expect(workflow).toContain('PR_SIZE_THRESHOLD: "400"');
    expect(job("pr-size-weekly")).toContain("python3 .github/scripts/pr_size.py weekly");
    expect(workflow).toMatch(/\n  schedule:\n    - cron: '17 7 \* \* 1'\n/);
  });
});
