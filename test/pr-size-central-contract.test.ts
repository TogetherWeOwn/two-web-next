import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The advisory size labeller moved from a per-repo script to the org central
// reusable, and this repo keeps only a thin caller. This contract pins the
// moved behaviour in its new location so deleting the local copy cannot
// silently drop coverage: exactly one of the local script and the central
// caller must carry the labelling, the exclusions, and the advisory-only
// wiring. A head with neither fails here first, before the floor guard
// reports the deletion; a head with both fails too, rejecting a half-finished
// move that leaves the local copy behind as dead code.
const workflow = readFileSync(".github/workflows/pr-size.yml", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const job = (id: string) =>
  workflow.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";
const CENTRAL_RE =
  /uses:\s*TogetherWeOwn\/\.github\/\.github\/workflows\/pr-size(-weekly)?\.yml@([0-9a-f]{40})/g;

describe("pr-size moved-behaviour contract", () => {
  it("documents the size boundaries", () => {
    expect(contributing).toContain("`size/S` (up to 100");
    expect(contributing).toContain("`size/M` (up to 400)");
    expect(contributing).toContain("`size/L` (up to 1000) or `size/XL`");
  });

  it("excludes this repo's generated paths but keeps hand-written SQL counted", () => {
    const extra =
      job("pr-size").match(/exclude-extra: "([^"]*)"/)?.[1] ??
      workflow.match(/PR_SIZE_EXCLUDE_EXTRA: "([^"]*)"/)?.[1] ??
      "";
    expect(extra.split(",")).toContain("public/islands/**");
    expect(extra.split(",")).toContain("public/styles.css");
    expect(extra.split(",")).toContain("drizzle/meta/**");
    expect(extra).not.toContain("drizzle/*.sql");
    expect(extra.split(",")).not.toContain("drizzle/**");
  });

  it("stays advisory-only", () => {
    const branchProtection =
      contributing.split("### Branch protection and required checks")[1]?.split(/\n#{2,3} /)[0] ??
      "";
    expect(branchProtection).not.toContain("pr-size");
    const topLevel = workflow.split(/\npermissions:\n/)[1]?.split(/\n\S/)[0] ?? "";
    expect(topLevel).not.toMatch(/\bwrite\b/);
    expect(job("pr-size")).toContain("      issues: write\n");
    expect(job("pr-size")).toContain("      pull-requests: write\n");
    expect(job("pr-size-weekly")).not.toMatch(/\bwrite\b/);
  });

  it("carries the labeller from exactly one source of truth", () => {
    const hasLocal = existsSync(".github/scripts/pr_size.py");
    const pins = [...workflow.matchAll(CENTRAL_RE)].map((m) => m[2]);
    const hasCentral = pins.length === 2 && pins[0] === pins[1];
    // Failing-first core: a head that deletes the local script without
    // wiring the central caller fails here, proving the move lost coverage.
    // XOR: a half-finished move that wires the central caller but leaves the
    // local script behind as dead code fails here too.
    expect(hasLocal !== hasCentral).toBe(true);
    if (hasCentral) {
      expect(job("pr-size")).toMatch(/workflows\/pr-size\.yml@/);
      expect(job("pr-size-weekly")).toMatch(/workflows\/pr-size-weekly\.yml@/);
      expect(workflow.match(/\n    uses: /g)).toHaveLength(2);
      expect(workflow).not.toContain("secrets:");
      expect(workflow).not.toContain("python3");
      expect(workflow).not.toContain("PR_SIZE_THRESHOLD");
    }
    if (hasLocal) {
      const script = readFileSync(".github/scripts/pr_size.py", "utf8");
      expect(script).toContain('("S", 100');
      expect(script).toContain('("M", 400');
      expect(script).toContain('("L", 1000');
    }
  });

  it("keeps the Monday weekly tally schedule", () => {
    expect(workflow).toMatch(/\n  schedule:\n    - cron: (["'])17 7 \* \* 1\1\n/);
  });
});
