// Moderator recompute from Discord snowflake role IDs. Never names.
//
// Legacy port: two-web `DiscordLoginController::isModerator` matched the member's
// role list against `DISCORD_MODERATOR_ROLE_IDS` by ID intersection, failing
// closed on a blank allowlist. One deliberate difference: legacy read roles with
// the *user* token (`identify` + `guilds.members.read`) and refused sign-in when
// that lookup was unavailable. Here the user keeps the `identify` + `guilds.join`
// consent screen (no re-consent), and roles are re-read with the *bot* token
// (`GET /guilds/{guild}/members/{user}`). A failed lookup fails closed on the
// flag (moderator = false) but never blocks sign-in: the privilege is denied by
// default while the front door stays open.

import { discordFetch } from "./discord-http";

const API = "https://discord.com/api/v10";

export type GuildMemberRoles = { roles: string[]; joinedAt: string | null };

export async function fetchMemberRoles(
  guildId: string,
  userId: string,
  botToken: string,
): Promise<GuildMemberRoles | null> {
  // Fail closed on an unconfigured bot token (TOG-12687): no bot call is
  // emitted, so the caller degrades to a non-moderator flag.
  if (!botToken || botToken.trim().length === 0) return null;
  const res = await discordFetch(`${API}/guilds/${guildId}/members/${userId}`, {
    headers: { authorization: `Bot ${botToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn("moderator recompute lookup failed", { status: res.status });
    return null;
  }
  // Discord answers JSON here; a non-JSON edge response is a failed lookup, not a crash.
  let body: { roles?: unknown; joined_at?: unknown };
  try {
    body = (await res.json()) as { roles?: unknown; joined_at?: unknown };
  } catch {
    console.warn("moderator recompute lookup returned non-JSON");
    return null;
  }
  const roles = Array.isArray(body.roles)
    ? body.roles.filter((r): r is string => typeof r === "string")
    : [];
  return { roles, joinedAt: typeof body.joined_at === "string" ? body.joined_at : null };
}

/** Parse `DISCORD_MODERATOR_ROLE_IDS` ("id1,id2") into snowflakes. Blank = nobody. */
export function parseModeratorRoleIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{10,25}$/.test(s));
}

/** ID intersection, never name matching. A blank allowlist fails closed. */
export function isModerator(memberRoles: string[], moderatorRoleIds: string[]): boolean {
  if (moderatorRoleIds.length === 0) return false;
  const allow = new Set(moderatorRoleIds);
  return memberRoles.some((r) => allow.has(r));
}

/**
 * Recompute the moderator flag for a user. Returns false when the allowlist is
 * blank (no lookup is even attempted) or when Discord cannot answer.
 */
export async function recomputeModerator(opts: {
  guildId: string;
  userId: string;
  botToken: string;
  moderatorRoleIds: string[];
}): Promise<boolean> {
  if (opts.moderatorRoleIds.length === 0) return false;
  // Fail closed before any lookup (TOG-12687): a blank bot token means no
  // bot-credentialed role fetch, so the flag stays non-moderator.
  if (!opts.botToken || opts.botToken.trim().length === 0) return false;
  const member = await fetchMemberRoles(opts.guildId, opts.userId, opts.botToken).catch(() => null);
  if (!member) return false;
  return isModerator(member.roles, opts.moderatorRoleIds);
}
