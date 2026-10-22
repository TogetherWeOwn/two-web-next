import journal from "../drizzle/meta/_journal.json";

// JSON is bundled by Wrangler: no filesystem access or migrator in the Worker.
// Only this repository's web 1000-series entries participate; bot rows and the
// grandfathered 0000/0001 tags are outside this readiness gate.
export const WEB_MIGRATIONS = journal.entries.filter((entry) => /^1\d{3}_/.test(entry.tag));

export function appliedMigrationTimestamps(rows: readonly { created_at: unknown }[]): number[] {
  return rows.map(({ created_at }) => {
    if (
      (typeof created_at !== "number" && typeof created_at !== "string") ||
      !/^\d+$/.test(String(created_at)) ||
      !Number.isSafeInteger(Number(created_at))
    ) {
      throw new Error("Invalid migration timestamp");
    }
    return Number(created_at);
  });
}

export function pendingWebMigrations(rows: readonly { created_at: unknown }[]): number {
  const applied = new Set(appliedMigrationTimestamps(rows));
  return WEB_MIGRATIONS.filter((entry) => !applied.has(entry.when)).length;
}

// Sorted applied `created_at` set for the production deploy gate: the gate
// proves a manually migrated production contains the target's migrations by
// set inclusion, never by high-water mark. A max is not a proof — a newer
// bot row (or any foreign row) would mask a missing web migration, the exact
// comparison ci/db-migrate.mjs refuses ("edited SQL, missing history, bot
// entries, or a newer release cannot hide work"). Shares the validated parse
// above, so a malformed row fails both signals together.
export function migrationLedger(rows: readonly { created_at: unknown }[]): number[] {
  return appliedMigrationTimestamps(rows).sort((a, b) => a - b);
}
