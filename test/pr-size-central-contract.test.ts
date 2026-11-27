import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The org gate carries the advisory labeller and its exclusions.
const workflow = readFileSync(".github/workflows/pr-size.yml", "utf8").replace(
  /^(      (?:issues|pull-requests): (?:read|write))[ \t]+#[^\n]*$/gm,
  "$1",
);
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const job = (id: string) =>
  workflow.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";
const CENTRAL_RE =
  /uses:\s*TogetherWeOwn\/\.github\/\.github\/workflows\/pr-size(-gate|-weekly)?\.yml@([0-9a-f]{40})/g;

describe("pr-size moved-behaviour contract", () => {
  it("documents the size boundaries", () => {
    expect(contributing).toContain("`size/S` (up to 100");
    expect(contributing).toContain("`size/M` (up to 400)");
    expect(contributing).toContain("`size/L` (up to 1000) or `size/XL`");
  });

  it("excludes this repo's generated paths but keeps hand-written SQL counted", () => {
    const extra = job("pr-size-gate").match(/^      exclude-extra: "([^"]*)"$/m)?.[1] ?? "";
    expect(extra.split(",")).toContain("public/islands/**");
    expect(extra.split(",")).toContain("public/styles.css");
    expect(extra.split(",")).toContain("drizzle/meta/**");
    expect(extra).not.toContain("drizzle/*.sql");
    expect(extra.split(",")).not.toContain("drizzle/**");
  });

  it("stays advisory-only except for the required gate", () => {
    const branchProtection =
      contributing.split("### Branch protection and required checks")[1]?.split(/\n#{2,3} /)[0] ??
      "";
    // The advisory labeller must never join the required set; the gate is
    // the one deliberate required exception.
    expect(branchProtection).not.toContain("`pr-size`");
    expect(branchProtection).toContain("`pr-size-gate`");
    const topLevel = workflow.split(/\npermissions:\n/)[1]?.split(/\n\S/)[0] ?? "";
    expect(topLevel).not.toMatch(/\bwrite\b/);
    expect(job("pr-size")).toBe("");
    expect(workflow).not.toMatch(/workflows\/pr-size\.yml@/);
    expect(job("pr-size-gate")).toContain("      issues: write\n");
    expect(job("pr-size-gate")).toContain("      pull-requests: write\n");
    expect(job("pr-size-weekly")).not.toMatch(/\bwrite\b/);
  });

  it("carries the labeller from exactly one source of truth", () => {
    const pins = [...workflow.matchAll(CENTRAL_RE)].map((m) => m[2]);
    expect(existsSync(".github/scripts/pr_size.py")).toBe(false);
    expect(pins).toHaveLength(2);
    expect(new Set(pins).size).toBe(1);
    expect(job("pr-size-gate")).toMatch(/workflows\/pr-size-gate\.yml@/);
    expect(job("pr-size-gate")).toMatch(/^      advisory-label: true$/m);
    expect(job("pr-size-weekly")).toMatch(/workflows\/pr-size-weekly\.yml@/);
    expect(workflow.match(/\n    uses: /g)).toHaveLength(2);
    expect(workflow).not.toContain("secrets:");
    expect(workflow).not.toContain("python3");
    expect(workflow).not.toContain("PR_SIZE_THRESHOLD");
    expect(job("pr-size-gate")).not.toMatch(/^      [\w-]*threshold:/m);
  });

  it("keeps the Monday weekly tally schedule", () => {
    expect(workflow).toMatch(/\n  schedule:\n    - cron: (["'])17 7 \* \* 1\1\n/);
  });
});
