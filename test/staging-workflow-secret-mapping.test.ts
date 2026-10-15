import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins the staging repoint: staging dumps, the census and the importer
// dry-run must read the PlanetScale staging secret. Without this, a revert
// to the retired Neon secret name would pass every suite, and once that
// secret is deleted the backup probe would skip green while dumping nothing.
// Grep-level, no YAML parser, no secrets, no network. Kept in its own file
// so the renamed production-mapping suite stays a clean rename for the
// floor guard's rename detection.
function codeOnly(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

describe("staging workflow secret mapping", () => {
  it("reads staging through PLANETSCALE_STAGING_DATABASE_URL in db-backup.yml", () => {
    const code = codeOnly(".github/workflows/db-backup.yml");
    expect(code).toContain("STAGING_URL: ${{ secrets.PLANETSCALE_STAGING_DATABASE_URL }}");
    expect(code).toContain(
      "DATABASE_URL: ${{ inputs.target == 'production' && secrets.PRODUCTION_BACKUP_DATABASE_URL || secrets.PLANETSCALE_STAGING_DATABASE_URL }}",
    );
  });

  it("reads staging through PLANETSCALE_STAGING_DATABASE_URL in staging-census.yml", () => {
    expect(codeOnly(".github/workflows/staging-census.yml")).toContain(
      "PLANETSCALE_STAGING_DATABASE_URL: ${{ secrets.PLANETSCALE_STAGING_DATABASE_URL }}",
    );
  });

  it("reads staging through PLANETSCALE_STAGING_DATABASE_URL in staging-importer-dryrun.yml", () => {
    expect(codeOnly(".github/workflows/staging-importer-dryrun.yml")).toContain(
      "DATABASE_URL: ${{ secrets.PLANETSCALE_STAGING_DATABASE_URL }}",
    );
  });

  it("no workflow references the retired NEON_STAGING_DATABASE_URL secret", () => {
    const workflowFiles = readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name));
    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const name of workflowFiles) {
      expect(readFileSync(`.github/workflows/${name}`, "utf8"), name).not.toContain(
        "NEON_STAGING_DATABASE_URL",
      );
    }
  });
});
