import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { name?: string; env?: Record<string, string>; run?: string };
type Job = {
  if?: string;
  uses?: string;
  permissions?: Record<string, string>;
  needs?: string[];
  steps?: Step[];
};
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  on: Record<string, unknown>;
  concurrency: Record<string, string>;
  jobs: Record<string, Job>;
};
const guard = "github.event_name == 'pull_request' && github.event.repository.private == false";
const caller = workflow.jobs["public-pr-security"];
const aggregate = workflow.jobs["ci-ok"]!;
const gate = aggregate.steps?.find((step) => step.name === "Require public PR security evidence");

describe("public PR security CI contract", () => {
  it("calls only the reviewed immutable reusable with the complete nested OSV permissions", () => {
    expect(caller).toEqual({
      if: guard,
      permissions: { actions: "read", contents: "read", "security-events": "write" },
      uses: "TogetherWeOwn/.github/.github/workflows/public-pr-security.yml@feb1e0e2111da007f38ca75ee95c6f6944723d36",
    });
    expect(workflow.on).toHaveProperty("pull_request");
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency["cancel-in-progress"]).toContain("github.ref != 'refs/heads/main'");
  });

  it("keeps every existing upstream gate and reports despite a skipped or failed caller", () => {
    expect(aggregate.if).toBe("${{ !cancelled() }}");
    expect(aggregate.needs).toEqual([
      "a11y",
      "lighthouse",
      "bundle-budget",
      "docs-links",
      "check",
      "node22-compat",
      "scope",
      "public-pr-security",
    ]);
    expect(gate?.env).toEqual({
      SECURITY_SELECTED: `\${{ ${guard} }}`,
      SECURITY_RESULT: "${{ needs.public-pr-security.result }}",
    });
    expect(gate).not.toHaveProperty("if");
  });

  for (const selected of ["true", "false", "", "unknown"]) {
    for (const result of ["success", "failure", "cancelled", "skipped", "", "unknown"]) {
      it(`aggregates selected=${selected || "missing"}, result=${result || "missing"} fail-closed`, () => {
        expect(gate?.run).toBeTruthy();
        const run = spawnSync("bash", ["-eu", "-c", gate?.run ?? "exit 99"], {
          env: { PATH: process.env.PATH, SECURITY_SELECTED: selected, SECURITY_RESULT: result },
          encoding: "utf8",
        });
        const accepted =
          (selected === "true" && result === "success") ||
          (selected === "false" && result === "skipped");
        expect(run.status === 0, run.stderr).toBe(accepted);
      });
    }
  }

  it("retains the existing grouped weekly GitHub Actions updates without displacing npm", () => {
    const dependabot = parse(readFileSync(".github/dependabot.yml", "utf8")) as {
      updates: {
        "package-ecosystem": string;
        directory: string;
        schedule: { interval: string };
        groups?: Record<string, { "applies-to": string }>;
      }[];
    };
    expect(
      dependabot.updates.map((update) => [update["package-ecosystem"], update.directory]),
    ).toEqual([
      ["npm", "/"],
      ["npm", "/web"],
      ["github-actions", "/"],
    ]);
    const actions = dependabot.updates[2]!;
    expect(actions.schedule.interval).toBe("weekly");
    expect(Object.values(actions.groups ?? {}).map((group) => group["applies-to"])).toEqual([
      "version-updates",
      "version-updates",
    ]);
  });
});
