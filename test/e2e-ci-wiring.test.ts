import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function checkCommands(): string[] {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const check = workflow.jobs.check;
  expect(check.name).toBe("check");
  const steps = check.steps.filter(
    (step: { name?: string }) => step.name === "Check (lint + typecheck + coverage gate)",
  );
  expect(steps).toHaveLength(1);
  expect(steps[0].run.trim()).toBe("npm run check:core");
  expect(steps[0].if).toBe(
    "(needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true')",
  );

  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const core = pkg.scripts["check:core"];
  expect(core).toEqual(expect.any(String));
  const commands = core.split(/\s*&&\s*/);
  // Fail closed on shell syntax that could comment out or bypass a later stage.
  for (const command of commands) {
    expect(command).toMatch(/^(?:npm run [\w:-]+|node --test [\w./* -]+)$/);
  }
  return commands;
}

describe("e2e CI wiring", () => {
  it("runs e2e:typecheck in the PR check job", () => {
    expect(checkCommands()).toContain("npm run e2e:typecheck");
  });

  it("runs e2e:safety in the PR check job", () => {
    expect(checkCommands()).toContain("npm run e2e:safety");
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
