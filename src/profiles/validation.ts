// Profile write validation (ports UpdateProfileRequest): bio ≤ 1000, games ≤ 20
// entries of ≤ 80 chars (trimmed, blank dropped, de-duplicated in order),
// timezone a real IANA zone or blank. `games_text` (one per line) is the form
// shape; `games` the array shape.

export type ProfileAttrs = { bio: string | null; games: string[]; timezone: string | null };
export type ProfileInput = Record<string, unknown>;

// Match the MemberProfile browser policy; tab, LF and CR remain allowed.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function isIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

export function validateProfile(
  input: ProfileInput,
): { ok: true; attrs: ProfileAttrs } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const bioRaw = input.bio ?? null;
  if (bioRaw !== null && typeof bioRaw !== "string") errors.bio = "Bio must be text.";
  else if (typeof bioRaw === "string" && [...bioRaw].length > 1000) errors.bio = "Keep your bio to 1000 characters or fewer.";
  else if (typeof bioRaw === "string" && CONTROL_CHARS.test(bioRaw)) errors.bio = "Remove control characters.";

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
      // Check raw input: trim() would hide forbidden VT/FF at the edges.
      if (CONTROL_CHARS.test(g)) errors.games ??= "Remove control characters.";
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

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const bio = typeof bioRaw === "string" && bioRaw.trim() !== "" ? bioRaw.trim() : null;
  return { ok: true, attrs: { bio, games, timezone } };
}
