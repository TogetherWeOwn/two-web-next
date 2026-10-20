import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the db-backup workflow's branch/target correspondence wiring: the
// dump source is chosen by `target` while the R2 prefix is chosen by the
// free-form `branch` input, so a dispatch naming the other target as branch
// (target=staging, branch=production or the reverse) would publish one
// database's dump under the other's prefix. The workflow must hand the
// declared target to bin/db-backup.sh as BACKUP_TARGET (the script refuses
// a branch naming the other target; see ci/db-backup-branch-target-selftest.sh),
// wired so every script step sees it (job env is the natural place).
// Grep-level, no YAML parser, no secrets, no network, no dispatch.
const workflow = readFileSync(".github/workflows/db-backup.yml", "utf8");
const code = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("db-backup branch/target correspondence wiring", () => {
  it("passes the dispatched target to the backup script as BACKUP_TARGET", () => {
    expect(code).toMatch(/BACKUP_TARGET:\s*\$\{\{[^}]*inputs\.target/);
  });

  it("keeps the empty branch input defaulting per-target", () => {
    // Control (unchanged behavior): empty `branch` input resolves to the
    // target's own name before the script ever runs.
    expect(code).toMatch(/inputs\.branch\s*\|\|\s*\(inputs\.target == 'production'/);
    expect(code).toContain("options: [staging, production]");
  });

  it("keeps every branch-taking script step on the resolved BRANCH", () => {
    // Control (unchanged behavior): all four commands still run against the
    // single resolved $BRANCH the correspondence guard validates.
    for (const cmd of ["backup", "promote-weekly", "rotate", "check"]) {
      expect(code).toContain(`./bin/db-backup.sh ${cmd} "$BRANCH"`);
    }
  });
});
