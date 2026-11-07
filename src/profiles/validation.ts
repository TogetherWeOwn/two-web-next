// Profile write validation (ports UpdateProfileRequest): bio ≤ 1000, games ≤ 20
// entries of ≤ 80 chars (trimmed, blank dropped, de-duplicated in order),
// timezone a real IANA zone or blank. `games_text` (one per line) is the form
// shape; `games` the array shape.

import { containsControlCharacters } from "../admin/validation-shared";

export type ProfileAttrs = {
  bio: string | null;
  games: string[];
  timezone: string | null;
  /** Present only when the request names it; absent preserves the stored choice. */
  leaderboardOptOut?: boolean;
};
export type ProfileInput = Record<string, unknown>;

export function isIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

const OPT_OUT_TRUTHY = new Set(["1", "true", "on", "yes"]);
const OPT_OUT_FALSY = new Set(["0", "false", "off", "no", ""]);

// Best-effort read of the leaderboard switch for re-rendering a failed save:
// a boolean for anything recognizable, undefined for absent or garbage.
export function normalizeLeaderboardOptOut(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  const values = Array.isArray(value) ? value : [value];
  let seen: boolean | undefined;
  for (const v of values) {
    if (typeof v === "boolean") {
      seen = v;
      continue;
    }
    if (typeof v === "number") {
      if (v === 1) {
        seen = true;
        continue;
      }
      if (v === 0) {
        seen = false;
        continue;
      }
      return undefined;
    }
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (OPT_OUT_TRUTHY.has(t)) {
        seen = true;
        continue;
      }
      if (OPT_OUT_FALSY.has(t)) {
        seen = false;
        continue;
      }
    }
    return undefined;
  }
  return seen;
}

export function validateProfile(
  input: ProfileInput,
): { ok: true; attrs: ProfileAttrs } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const bioRaw = input.bio ?? null;
  if (bioRaw !== null && typeof bioRaw !== "string") errors.bio = "Bio must be text.";
  else if (typeof bioRaw === "string" && [...bioRaw].length > 1000)
    errors.bio = "Keep your bio to 1000 characters or fewer.";
  else if (typeof bioRaw === "string" && containsControlCharacters(bioRaw))
    errors.bio = "Remove control or invisible characters.";

  let gamesRaw: unknown = input.games;
  if (typeof input.games_text === "string") {
    if ([...input.games_text].length > 1700) errors.games = "Games list is too long.";
    gamesRaw = input.games_text.split(/\r\n|\r|\n/);
  }
  const games: string[] = [];
  if (!Array.isArray(gamesRaw)) {
    errors.games ??= "Games must be a list.";
  } else {
    for (const g of gamesRaw) {
      if (typeof g !== "string") {
        errors.games ??= "Each game must be text.";
        continue;
      }
      // Check raw input: trim() would hide forbidden VT/FF/BOM at the edges.
      if (containsControlCharacters(g)) errors.games ??= "Remove control or invisible characters.";
      const t = g.trim();
      if ([...t].length > 80) errors.games ??= "Keep each game name to 80 characters or fewer.";
      if (t !== "" && !games.includes(t)) games.push(t);
    }
    if (games.length > 20) errors.games ??= "Add no more than 20 games.";
  }

  const tzRaw = input.timezone ?? null;
  let timezone: string | null = null;
  if (tzRaw !== null && typeof tzRaw !== "string") errors.timezone = "Timezone must be text.";
  else if (typeof tzRaw === "string" && tzRaw !== "") {
    if (isIanaTimeZone(tzRaw)) timezone = tzRaw;
    else errors.timezone = "Choose a valid IANA timezone, e.g. Europe/London.";
  }

  // The leaderboard switch is optional: an absent key preserves the stored
  // choice, so clients that predate the switch can never silently opt a
  // member back in. Present values must be recognizable booleans.
  const optRaw = input.leaderboard_opt_out;
  let leaderboardOptOut: boolean | undefined;
  if (optRaw !== undefined && optRaw !== null) {
    const normalized = normalizeLeaderboardOptOut(optRaw);
    if (normalized === undefined)
      errors.leaderboard_opt_out = "Choose whether to appear on the member leaderboard.";
    else leaderboardOptOut = normalized;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const bio = typeof bioRaw === "string" && bioRaw.trim() !== "" ? bioRaw.trim() : null;
  return {
    ok: true,
    attrs:
      leaderboardOptOut === undefined
        ? { bio, games, timezone }
        : { bio, games, timezone, leaderboardOptOut },
  };
}
