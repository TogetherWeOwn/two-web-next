import journal from "../drizzle/meta/_journal.json";

// JSON is bundled by Wrangler: no filesystem access or migrator in the Worker.
// Only this repository's web 1000-series entries participate; bot rows and the
// grandfathered 0000/0001 tags are outside this readiness gate.
export const WEB_MIGRATIONS = journal.entries.filter((entry) => /^1\d{3}_/.test(entry.tag));

// This build switch is reserved for the all-Hono cutover and its Hono undo.
// Ordinary builds require the full journal. Release admission must bind the
// switch to the reviewed artifact and verify all Kit route families are off.
declare const __TWO_WEB_1033_COMPAT__: boolean;

// These exact migrations prepare dormant features. Keep this list explicit so
// a newly added migration cannot become optional by crossing a numeric cutoff.
const optionalCutoverTags = new Set([
  "1034_event-echoes",
  "1035_bot-reconciliation-intents",
  "1036_event-sync-claim-started",
  "1037_waitlist-offers",
  "1038_announcement-send-claims",
]);

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

export function pendingWebMigrations(
  rows: readonly { created_at: unknown }[],
  cutoverBuild = typeof __TWO_WEB_1033_COMPAT__ !== "undefined" && __TWO_WEB_1033_COMPAT__ === true,
): number {
  const applied = new Set(appliedMigrationTimestamps(rows));
  // In the cutover build only an unapplied suffix of the explicitly optional
  // tags may be absent. Later web entries cannot hide a hole in the prefix.
  let requiredCount = WEB_MIGRATIONS.length;
  while (cutoverBuild && requiredCount > 0) {
    const { tag, when } = WEB_MIGRATIONS[requiredCount - 1]!;
    if (!optionalCutoverTags.has(tag) || applied.has(when)) break;
    requiredCount -= 1;
  }
  return WEB_MIGRATIONS.slice(0, requiredCount).filter(({ when }) => !applied.has(when)).length;
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
