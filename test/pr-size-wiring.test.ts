import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The required gate runs the best-effort labeller in the same runner.
// Its job-level grant covers both steps; the weekly tally stays read-only.
const workflowSource = readFileSync(".github/workflows/pr-size.yml", "utf8");
const workflow = workflowSource.replace(
  /^(      (?:issues|pull-requests): (?:read|write))[ \t]+#[^\n]*$/gm,
  "$1",
);
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const job = (id: string, source = workflow) =>
  source.split(new RegExp(`\\n  ${id}:\\n`))[1]?.split(/\n  [A-Za-z0-9_-]+:\n/)[0] ?? "";
const PERMISSION_BLOCK = /^    permissions:\n([\s\S]*?)(?=^    [A-Za-z][A-Za-z0-9_-]*:)/m;
const CENTRAL = "TogetherWeOwn/.github/.github/workflows";
const REVIEWED_CENTRAL_SHA = "649943c1ed8a1af8f8760e075f3923237dd72e50";

describe("pr-size advisory wiring", () => {
  it("keeps the advisory jobs out of the required set and names the required gate", () => {
    const branchProtection = contributing
      .split("### Branch protection and required checks")[1]
      ?.split(/\n#{2,3} /)[0];
    expect(branchProtection).toBeTruthy();
    expect(branchProtection).toContain("`ci-ok`");
    expect(branchProtection).toContain("`pr-size-gate / gate`");
    expect(branchProtection).not.toContain("`pr-size`");
    expect(branchProtection).not.toContain("`pr-size / label`");
  });

  it("grants write scopes only to the gate job", () => {
    expect(workflow.match(/^permissions:/gm)).toHaveLength(1);
    const topLevel = workflow.match(/^permissions:\n([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9_-]*:)/m)?.[1];
    expect(topLevel?.trim()).toBe("contents: read");
    for (const id of ["pr-size-gate", "pr-size-weekly"]) {
      const callerJob = job(id);
      expect(callerJob.match(/^    permissions:/gm)).toHaveLength(1);
      const callerPermissions = callerJob.match(PERMISSION_BLOCK)?.[1];
      const access = id === "pr-size-weekly" ? "read" : "write";
      expect(callerPermissions?.trimEnd()).toBe(
        `      contents: read\n      issues: ${access}\n      pull-requests: ${access}`,
      );
    }
    expect(job("pr-size-weekly")).not.toMatch(/\bwrite\b/);
    // Fail closed on any added job or write scope beyond the gate's grant.
    const jobsText = workflow.split("\njobs:\n")[1] ?? "";
    expect([...jobsText.matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map((m) => m[1])).toEqual([
      "pr-size-gate",
      "pr-size-weekly",
    ]);
    expect(workflow.match(/\bwrite\b/g)).toHaveLength(2);
  });

  it("documents each non-contents grant on its own permission line", () => {
    const { jobs } = parse(workflowSource);
    for (const [id, access] of [
      ["pr-size-gate", "write"],
      ["pr-size-weekly", "read"],
    ] as const) {
      expect(jobs[id].permissions).toEqual({
        contents: "read",
        issues: access,
        "pull-requests": access,
      });
      const callerPermissions = job(id, workflowSource).match(PERMISSION_BLOCK)?.[1];
      for (const scope of ["issues", "pull-requests"]) {
        expect(callerPermissions).toMatch(
          new RegExp(`^      ${scope}: ${access}[ \\t]+#[ \\t]*\\S`, "m"),
        );
      }
    }
  });

  it("calls the central reusables at one pinned full SHA", () => {
    const gatePin = job("pr-size-gate").match(
      new RegExp(`uses: ${CENTRAL.replaceAll(".", "\\.")}/pr-size-gate\\.yml@([0-9a-f]{40})`),
    )?.[1];
    const weeklyPin = job("pr-size-weekly").match(
      new RegExp(`uses: ${CENTRAL.replaceAll(".", "\\.")}/pr-size-weekly\\.yml@([0-9a-f]{40})`),
    )?.[1];
    expect(gatePin).toBeTruthy();
    expect(gatePin).toBe(REVIEWED_CENTRAL_SHA);
    expect(weeklyPin).toBe(REVIEWED_CENTRAL_SHA);
    expect(weeklyPin).toBe(gatePin);
    expect(parse(workflow).jobs["pr-size-gate"].with["advisory-label"]).toBe(true);
    // No floating refs, no other reusable calls, no secrets passthrough:
    // the caller token stays capped by the job grants above.
    expect(workflow.match(/\n    uses: /g)).toHaveLength(2);
    expect(workflow).not.toMatch(/secrets\s*:/);
    expect(workflow).not.toMatch(/uses: .*\/pr-size\.yml@/);
  });

  it("keeps no local labeller copy and sets no local threshold", () => {
    expect(existsSync(".github/scripts/pr_size.py")).toBe(false);
    expect(existsSync(".github/scripts/test_pr_size.py")).toBe(false);
    expect(workflow).not.toContain("PR_SIZE_THRESHOLD");
    expect(workflow).not.toContain("python3");
  });

  it("excludes this repo's generated paths but keeps hand-written SQL counted", () => {
    const gate = job("pr-size-gate");
    expect(gate.match(/^      exclude-extra:/gm)).toHaveLength(1);
    const extra = gate.match(/^      exclude-extra: "([^"]*)"$/m)?.[1] ?? "";
    expect(extra).toBe("public/islands/**,public/styles.css,drizzle/meta/**");
    expect(extra).not.toContain("drizzle/*.sql");
    expect(extra.split(",")).not.toContain("drizzle/**");
  });

  it("preserves PR, review, manual and scheduled routing", () => {
    const { on, concurrency, jobs } = parse(workflowSource);
    expect(on).toEqual({
      pull_request: {
        types: ["opened", "synchronize", "reopened", "ready_for_review", "labeled", "unlabeled"],
      },
      pull_request_review: { types: ["submitted", "dismissed"] },
      schedule: [{ cron: "17 7 * * 1" }],
      workflow_dispatch: {
        inputs: { pr_number: expect.objectContaining({ required: false, type: "string" }) },
      },
    });
    expect(concurrency).toEqual({
      group:
        "${{ github.workflow }}-${{ github.event.pull_request.number || inputs.pr_number || github.event_name }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
    expect(jobs["pr-size-gate"].name).toBe("pr-size-gate");
    expect(jobs["pr-size-gate"].if).toBe(
      "github.event_name == 'pull_request' || github.event_name == 'pull_request_review' || inputs.pr_number != ''",
    );
    expect(jobs["pr-size-gate"].with["pr-number"]).toBe("${{ inputs.pr_number || '' }}");
    expect(jobs["pr-size-weekly"].if).toBe(
      "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.pr_number == '')",
    );
  });
});
