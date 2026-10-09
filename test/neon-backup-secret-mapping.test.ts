import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the read-only production backup mapping: the production dump path in
// neon-backup.yml must read PRODUCTION_BACKUP_DATABASE_URL (read-only role on
// the PlanetScale direct endpoint), never the migration secret
// PRODUCTION_DATABASE_URL. Grep-level, no YAML parser, no secrets, no network.
const workflow = readFileSync(".github/workflows/neon-backup.yml", "utf8");
const code = workflow
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("neon-backup production secret mapping", () => {
  it("reads production dumps through PRODUCTION_BACKUP_DATABASE_URL, never PRODUCTION_DATABASE_URL", () => {
    // Both the probe gate and the dump mapping reference the read-only secret.
    expect(code).toContain(
      "PRODUCTION_URL: ${{ inputs.target == 'production' && secrets.PRODUCTION_BACKUP_DATABASE_URL",
    );
    expect(code).toContain(
      "DATABASE_URL: ${{ inputs.target == 'production' && secrets.PRODUCTION_BACKUP_DATABASE_URL",
    );
    const backupRefs = code.match(/secrets\.PRODUCTION_BACKUP_DATABASE_URL\b/g) ?? [];
    expect(backupRefs.length).toBeGreaterThanOrEqual(2);

    // The migration secret must not appear in the dump workflow in any
    // spelling GitHub would resolve (dot or bracket syntax).
    expect(code).not.toMatch(/secrets\.PRODUCTION_DATABASE_URL\b/);
    expect(code).not.toMatch(/secrets\s*\[\s*['"]PRODUCTION_DATABASE_URL['"]\s*\]/i);
    // Bare-token check fails closed after removing the read-only name (which
    // does not contain the migration name as a substring).
    const withoutBackup = workflow.split("PRODUCTION_BACKUP_DATABASE_URL").join("");
    expect(withoutBackup).not.toMatch(/PRODUCTION_DATABASE_URL/);
  });
});
