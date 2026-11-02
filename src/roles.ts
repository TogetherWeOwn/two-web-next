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

// Charset-bound Discord IDs, same contract as `isDiscordId` in `./discord`:
// ASCII digits only, nonempty, tested as-is with no trimming, coercion or
// decoding. Kept local (not imported) so the `bin/check-moderators.mjs`
// strip-only CLI never loads `./discord`, whose parameter properties Node's
// type-stripping cannot parse.
function isDiscordId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

export type GuildMemberRoles = { roles: string[]; joinedAt: string | null };

/**
 * One guild-member lookup, keeping the three outcomes apart that
 * `fetchMemberRoles` collapses to null: Discord answered for a member, the
 * user is not in the guild (404), or the lookup failed (admission, config,
 * HTTP failure, non-JSON). A transport rejection still propagates, exactly
 * as before, so each caller classifies it at its own boundary.
 * `rolesKnown` is false when a 200 body carries no roles array, or any
 * entry is not a snowflake: membership is still proven, but no definitive
 * role verdict can be derived from the shape.
 */
type GuildMemberLookup =
  | { kind: "member"; roles: string[]; rolesKnown: boolean; joinedAt: string | null }
  | { kind: "not_member" }
  | { kind: "failed" };

async function lookupGuildMember(
  guildId: string,
  userId: string,
  botToken: string,
): Promise<GuildMemberLookup> {
  // Charset admission first: a malformed guild or user id returns before
  // any header construction or fetch, so zero Discord requests are emitted.
  if (!isDiscordId(guildId) || !isDiscordId(userId)) return { kind: "failed" };
  // Fail closed on an unconfigured bot token (TOG-12687): no bot call is
  // emitted, so the caller degrades to a non-moderator flag.
  if (!botToken || botToken.trim().length === 0) return { kind: "failed" };
  const res = await discordFetch(
    `${API}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
    {
      headers: { authorization: `Bot ${botToken}` },
    },
  );
  if (res.status === 404) return { kind: "not_member" };
  if (!res.ok) {
    console.warn("moderator recompute lookup failed", { status: res.status, guild_id: guildId });
    return { kind: "failed" };
  }
  // Discord answers JSON here; a non-JSON edge response is a failed lookup, not a crash.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    console.warn("moderator recompute lookup returned non-JSON", { guild_id: guildId });
    return { kind: "failed" };
  }
  // A valid-JSON body with no object shape (null, scalar) carries no roles;
  // degrade to empty instead of throwing, so the recomputeModerator boundary
  // never misreports a shape miss as a transport failure. The flag verdict is
  // unchanged: empty roles still fail the allowlist intersection.
  const shape =
    typeof body === "object" && body !== null
      ? (body as { roles?: unknown; joined_at?: unknown })
      : null;
  const rawRoles = shape !== null && Array.isArray(shape.roles) ? (shape.roles as unknown[]) : null;
  // Known only when every entry is a snowflake. A malformed entry is a shape
  // miss, not an empty role list: the mid-session recheck must not read it as
  // a definitive demotion. `roles` keeps the legacy string-filtered list so
  // login derivation (`fetchMemberRoles`) is byte-for-byte unchanged.
  const rolesKnown = rawRoles !== null && rawRoles.every((r) => isDiscordId(r));
  const roles = rawRoles ? rawRoles.filter((r): r is string => typeof r === "string") : [];
  return {
    kind: "member",
    roles,
    rolesKnown,
    joinedAt: shape !== null && typeof shape.joined_at === "string" ? shape.joined_at : null,
  };
}

export async function fetchMemberRoles(
  guildId: string,
  userId: string,
  botToken: string,
): Promise<GuildMemberRoles | null> {
  const lookup = await lookupGuildMember(guildId, userId, botToken);
  return lookup.kind === "member" ? { roles: lookup.roles, joinedAt: lookup.joinedAt } : null;
}

/** Parse `DISCORD_MODERATOR_ROLE_IDS` ("id1,id2") into snowflakes. Blank = nobody. */
export function parseModeratorRoleIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{10,25}$/.test(s));
}

/** Class-only classification of a lookup rejection: never the message, which can carry wire detail. */
const MAX_LOOKUP_CLASS_LENGTH = 100;

function lookupExceptionClass(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.name
      : ((err as { constructor?: { name?: string } })?.constructor?.name ?? "unknown");
  // Only strings are sanitized: a non-string name must degrade to unknown
  // instead of throwing the degrading catch into a rejection.
  const name = typeof raw === "string" ? raw : "unknown";
  // De-newline and bound: a hostile error name must not forge log lines.
  return name.replace(/[\r\n]+/g, "_").slice(0, MAX_LOOKUP_CLASS_LENGTH) || "unknown";
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
  // The answered-path warns already fired inside fetchMemberRoles, so only a
  // transport rejection reaches this catch: one line per degraded lookup,
  // guild scope only, never member id, roles or credential.
  const member = await fetchMemberRoles(opts.guildId, opts.userId, opts.botToken).catch(
    (err: unknown) => {
      console.warn("moderator recompute lookup transport failed", {
        exception: lookupExceptionClass(err),
        guild_id: opts.guildId,
      });
      return null;
    },
  );
  if (!member) return false;
  return isModerator(member.roles, opts.moderatorRoleIds);
}

/**
 * Mid-session re-derivation of a session's member/moderator bits. Unlike
 * `recomputeModerator` at login — which fails closed to non-moderator
 * because nothing is granted yet — a live session already holds bits, so
 * only a definitive Discord answer may replace them: a guild-member body
 * whose roles array is well-formed (every entry a snowflake), or a 404
 * proving the user left the guild. Transport
 * failures, HTTP errors, missing configuration and shape misses resolve
 * to null ("inconclusive: keep the stored bits"), so a Discord outage
 * never strips privilege mid-session; the session's absolute age cap
 * remains the hard bound. A blank moderator allowlist still yields a
 * definitive membership verdict with moderator=false, matching login.
 */
export async function recheckGuildRoles(opts: {
  guildId: string;
  userId: string;
  botToken: string;
  moderatorRoleIds: string[];
}): Promise<{ member: boolean; moderator: boolean } | null> {
  const lookup = await lookupGuildMember(opts.guildId, opts.userId, opts.botToken).catch(
    (err: unknown) => {
      console.warn("session role recheck lookup transport failed", {
        exception: lookupExceptionClass(err),
        guild_id: opts.guildId,
      });
      return { kind: "failed" } as GuildMemberLookup;
    },
  );
  if (lookup.kind === "failed") return null;
  if (lookup.kind === "not_member") return { member: false, moderator: false };
  if (!lookup.rolesKnown) return null;
  return { member: true, moderator: isModerator(lookup.roles, opts.moderatorRoleIds) };
}
