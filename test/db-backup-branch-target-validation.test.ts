import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/db-backup.yml", "utf8");
const validationStep = workflow.match(
  /^      - name: Validate branch and target\n(?:(?!^      - ).*\n)*/m,
)?.[0];
const validation = validationStep?.match(/        run: \|\n((?:          [^\n]*\n)+)/)?.[1];

function validate(target: string, branch: string) {
  return spawnSync("python3", ["bin/backup/branch-target-helper", target, branch], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

describe("backup branch/target admission", () => {
  it.each(["staging", "production"])("defaults an empty branch to %s", (target) => {
    const result = validate(target, "");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${target}\n`);
  });

  it.each([
    ["staging", "production"],
    ["production", "staging"],
    ["staging", "scratch"],
    ["invalid", "test-scratch"],
  ])("refuses target=%s branch=%s with both inputs named", (target, branch) => {
    const result = validate(target, branch);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`target '${target}'`);
    expect(result.stderr).toContain(`branch '${branch}'`);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["staging", "staging"],
    ["production", "production"],
    ["staging", "test-scratch"],
    ["production", "test-scratch"],
    ["", "synthetic"],
  ])("accepts target=%s branch=%s", (target, branch) => {
    const result = validate(target, branch);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${branch}\n`);
  });

  it.each(["backup", "promote-weekly", "rotate", "check"])(
    "%s refuses both target swaps before URL checks or storage",
    (command) => {
      for (const [target, branch] of [
        ["staging", "production"],
        ["production", "staging"],
      ] as const) {
        const result = spawnSync("bash", ["bin/db-backup.sh", command, branch], {
          encoding: "utf8",
          env: { PATH: process.env.PATH, BACKUP_TARGET: target },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`target '${target}'`);
        expect(result.stderr).toContain(`branch '${branch}'`);
        expect(result.stderr).not.toContain("DATABASE_URL is unset");
        expect(result.stdout).toBe("");
      }
    },
  );

  it("wires the protected shell acceptance suite into required CI", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain(
      "      - name: Backup branch-target selftest (stubbed, no secrets)\n" +
        "        if: (needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true') && (needs.scope.outputs.full == 'true' || needs.scope.outputs.app == 'true')\n" +
        "        run: bash ci/db-backup-branch-target-selftest.sh\n",
    );
  });

  it("runs the shared validator before provisioning, without a ready/secret condition", () => {
    expect(validationStep).toBeDefined();
    expect(validationStep).not.toMatch(/^ {8}if:/m);
    expect(validation).toBeDefined();
    expect(workflow.indexOf("name: Validate branch and target")).toBeLessThan(
      workflow.indexOf("- id: probe"),
    );
    expect(validation).toContain(
      'python3 bin/backup/branch-target-helper "$BACKUP_TARGET" "$BRANCH"',
    );
  });

  it.each([
    ["staging", "production", 1],
    ["production", "staging", 1],
    ["staging", "staging", 0],
    ["production", "production", 0],
    ["staging", "test-scratch", 0],
    ["production", "test-scratch", 0],
  ])("executes workflow admission for target=%s branch=%s", (target, branch, status) => {
    expect(validation).toBeDefined();
    const result = spawnSync("bash", ["-c", validation || "exit 99"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, BACKUP_TARGET: target, BRANCH: branch },
    });
    expect(result.status, result.stderr).toBe(status);
    if (status !== 0) {
      expect(result.stderr).toContain(`target '${target}'`);
      expect(result.stderr).toContain(`branch '${branch}'`);
    }
  });
});
