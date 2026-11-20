import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isScalar, parseDocument } from "yaml";
import shardConfig from "../vitest.coverage-shard.config";
import coverageConfig from "../vitest.config";

const workflows = {
  ci: parseDocument(readFileSync(".github/workflows/ci.yml", "utf8")),
  e2e: parseDocument(readFileSync(".github/workflows/e2e.yml", "utf8")),
};

describe("CI workflow source boundaries", () => {
  it.each(Object.entries(workflows))(
    "keeps %s workflow grants read-only and documented",
    (_, workflow) => {
      expect(workflow.errors).toEqual([]);
      expect(workflow.toJS().permissions).toEqual({ contents: "read", "pull-requests": "read" });
      const grant = workflow.getIn(["permissions", "pull-requests"], true);
      expect(isScalar(grant) && grant.comment).toMatch(/scope job.*changed PR files/);
    },
  );

  it.each([
    ["a11y", "24-bookworm"],
    ["check", "24-bookworm"],
    ["coverage-shard", "24-bookworm"],
    ["coverage-merge", "24-bookworm"],
    ["kit-browser-fixture", "24-bookworm"],
    ["lighthouse", "24-bookworm"],
    ["node22-shard", "22.23.0-bookworm"],
    ["node22-compat", "22.23.0-bookworm"],
  ])("keeps %s on its Node tag with a digest", (job, tag) => {
    const image = workflows.ci.getIn(["jobs", job, "container", "image"]);
    expect(image).toMatch(/^node:[^@]+@sha256:[a-f0-9]{64}$/);
    expect(String(image).split("@")[0]).toBe(`node:${tag}`);
  });

  it.each([
    ["ci", "a11y", "postgres"],
    ["ci", "check", "postgres"],
    ["ci", "check", "catalog-postgres"],
    ["ci", "coverage-shard", "postgres"],
    ["ci", "node22-shard", "postgres"],
    ["e2e", "browser-smoke", "postgres"],
  ] as const)("pins the %s %s %s service to Postgres 17", (workflow, job, service) => {
    expect(workflows[workflow].getIn(["jobs", job, "services", service, "image"])).toMatch(
      /^postgres:17@sha256:[a-f0-9]{64}$/,
    );
  });

  it("keeps the shard's suite and coverage settings identical except for final reporting", () => {
    const { coverage, ...suite } = coverageConfig.test ?? {};
    expect(coverage?.thresholds).toBeDefined();
    expect(shardConfig.test).toEqual({
      ...suite,
      coverage: { ...coverage, thresholds: undefined, reporter: [] },
    });
  });

  it.each(["bundle-budget", "lighthouse"])(
    "explicitly names %s without renaming the check",
    (job) => {
      expect(workflows.ci.getIn(["jobs", job, "name"])).toBe(job);
    },
  );
});
