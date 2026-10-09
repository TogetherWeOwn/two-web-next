// Deploy-time moderator role-audit (W16 pre-flip verification).
//
// Compares the Discord-moderator set against the app-moderator set and exits
// non-zero on drift. Read-only: it compares ID lists the operator supplies —
// it never touches the network, never opens a database, never mutates roles,
// and never reads or prints tokens or secrets.
//
// Inputs are Discord user snowflakes (decimal strings). The operator builds
// the two lists with the documented read-only queries (see
// docs/cutover-check.md) and hands them to the CLI as files. This module is
// the pure comparison + bounded rendering; the CLI owns file parsing and
// exit codes.

export const ROLE_AUDIT_MAX_SHOWN = 20;

const SNOWFLAKE_RE = /^\d{10,25}$/;

export class InvalidRoleAuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRoleAuditInputError";
  }
}

/** Trim, drop empties, dedupe, sort. Rejects non-string entries. */
export function normalizeIdList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new InvalidRoleAuditInputError("expected an array of Discord user IDs.");
  }
  const seen = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== "string") {
      throw new InvalidRoleAuditInputError("expected an array of Discord user IDs.");
    }
    const id = entry.trim();
    if (id === "") continue;
    seen.add(id);
  }
  return [...seen].sort();
}

/** Fail on the first malformed snowflake with a bounded message (no full dump). */
export function assertSnowflakeIds(ids: string[], side: string): void {
  const bad = ids.filter((id) => !SNOWFLAKE_RE.test(id));
  if (bad.length === 0) return;
  const shown = bad
    .slice(0, 3)
    .map((v) => `'${v.slice(0, 32)}'`)
    .join(", ");
  const more = bad.length > 3 ? ` (and ${bad.length - 3} more)` : "";
  throw new InvalidRoleAuditInputError(
    `${side}: ${bad.length} malformed Discord user ID(s): ${shown}${more}. Expected 10-25 decimal digits.`,
  );
}

export type RoleAuditResult = {
  discordIds: string[];
  appIds: string[];
  /** In Discord but not in the app: these moderators would be denied the panel. */
  discordOnly: string[];
  /** In the app but not in Discord: excess privilege until the next login recompute. */
  appOnly: string[];
  discordCount: number;
  appCount: number;
  ok: boolean;
};

export function compareModeratorSets(discord: unknown, app: unknown): RoleAuditResult {
  const discordIds = normalizeIdList(discord);
  const appIds = normalizeIdList(app);
  assertSnowflakeIds(discordIds, "discord");
  assertSnowflakeIds(appIds, "app");
  const appSet = new Set(appIds);
  const discordSet = new Set(discordIds);
  const discordOnly = discordIds.filter((id) => !appSet.has(id));
  const appOnly = appIds.filter((id) => !discordSet.has(id));
  return {
    discordIds,
    appIds,
    discordOnly,
    appOnly,
    discordCount: discordIds.length,
    appCount: appIds.length,
    ok: discordOnly.length === 0 && appOnly.length === 0,
  };
}

function boundedList(ids: string[], maxShown: number): string {
  if (ids.length === 0) return "  (none)";
  const shown = ids.slice(0, maxShown);
  const lines = shown.map((id) => `  - ${id}`);
  if (ids.length > maxShown) lines.push(`  …and ${ids.length - maxShown} more`);
  return lines.join("\n");
}

export function renderRoleAuditReport(
  result: RoleAuditResult,
  maxShown: number = ROLE_AUDIT_MAX_SHOWN,
): string {
  const lines = [
    "moderator role audit: Discord set vs app set",
    `  discord moderators: ${result.discordCount}`,
    `  app moderators: ${result.appCount}`,
    `  discord-only (denied the panel): ${result.discordOnly.length}`,
    boundedList(result.discordOnly, maxShown),
    `  app-only (excess privilege): ${result.appOnly.length}`,
    boundedList(result.appOnly, maxShown),
    "",
    result.ok
      ? "  CLEAN: the sets match (empty-safe: no moderators on either side is a clean pass)."
      : "  DRIFT: the sets differ. Recompute app state from Discord roles, then re-run before the flip.",
    "  Read-only: no roles were changed by this check.",
  ];
  return lines.join("\n");
}

/** Bounded JSON for --json: truncated ID lists plus exact counts. */
export function roleAuditJson(
  result: RoleAuditResult,
  maxShown: number = ROLE_AUDIT_MAX_SHOWN,
): Record<string, unknown> {
  const truncate = (ids: string[]) => ({
    shown: ids.slice(0, maxShown),
    omitted: Math.max(0, ids.length - maxShown),
  });
  return {
    ok: result.ok,
    discordCount: result.discordCount,
    appCount: result.appCount,
    discordOnly: truncate(result.discordOnly),
    appOnly: truncate(result.appOnly),
  };
}
