import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
