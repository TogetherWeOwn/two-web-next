import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("e2e CI wiring", () => {
  it("runs e2e:typecheck in the PR check job", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const check = workflow.split("\n  check:\n")[1]!.split("\n  bundle-budget:\n")[0]!;
    expect(check).toContain("name: check");
    expect(check).toContain("npm run e2e:typecheck");
  });

  it("runs e2e:safety in the PR check job", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const check = workflow.split("\n  check:\n")[1]!.split("\n  bundle-budget:\n")[0]!;
    expect(check).toContain("name: check");
    expect(check).toContain("npm run e2e:safety");
  });

  it("retains canonical asset repair evidence without masking the failed gate", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const job = workflow.jobs["bundle-budget"];
    const steps: {
      id?: string;
      name?: string;
      run?: string;
      if?: string;
      uses?: string;
      with?: Record<string, unknown>;
    }[] = job.steps;
    const selftest = steps.find((step) => step.id === "asset_selftest")!;
    const check = steps.find((step) => step.id === "asset_check")!;
    const build = steps.find((step) => step.id === "asset_drift")!;
    const upload = steps.find((step) => step.name === "Upload asset drift evidence")!;

    expect(selftest.run).toBe("node ci/minify-assets.mjs --selftest");
    expect(check.run).toBe("node ci/minify-assets.mjs --check");
    expect(job).not.toHaveProperty("continue-on-error");
    for (const step of steps) expect(step).not.toHaveProperty("continue-on-error");
    expect(build.if).toBe(
      "failure() && (steps.asset_selftest.outcome == 'failure' || steps.asset_check.outcome == 'failure')",
    );
    expect(build.run!.trim().split("\n")).toEqual([
      "mkdir -p artifacts/asset-drift",
      "npm run build:assets",
      "git diff --binary -- public/ > artifacts/asset-drift/public-assets.patch",
    ]);
    expect(steps.indexOf(build)).toBeGreaterThan(steps.indexOf(check));
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(build));
    expect(upload.if).toBe("failure() && steps.asset_drift.outcome == 'success'");
    expect(upload.uses).toBe("actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
    expect(upload.with).toEqual({
      name: "asset-drift-${{ github.sha }}",
      path: "artifacts/asset-drift/public-assets.patch",
      "if-no-files-found": "error",
      "retention-days": 3,
    });
  });

  it("includes every e2e/**/*.test.mjs file in the e2e:safety script", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const safety = pkg.scripts["e2e:safety"] as string;
    expect(safety).toBeDefined();

    // Find all e2e/**/*.test.mjs files (excluding node_modules)
    const { execSync } = require("node:child_process");
    const files = execSync("find e2e -name '*.test.mjs' -not -path '*/node_modules/*' | sort", {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    for (const file of files) {
      expect(safety, `e2e:safety must include ${file}`).toContain(file);
    }
  });
});
