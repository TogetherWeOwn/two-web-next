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

// Maximum `created_at` across the whole ledger (web and grandfathered rows
// alike), or null when the ledger holds no rows. The production deploy gate
// compares this against the target journal's end to prove a manually migrated
// production already contains the target's migrations. Shares the validated
// parse above, so a malformed row fails both signals together.
export function migrationLedgerMax(rows: readonly { created_at: unknown }[]): number | null {
  const applied = appliedMigrationTimestamps(rows);
  return applied.length ? Math.max(...applied) : null;
}
