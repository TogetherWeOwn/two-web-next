// Mid-session Discord role re-derivation: the one refresh every authorizing
// session read runs before it trusts the stored member/moderator bits.
//
// Login derives the bits from Discord (src/roles.ts); without a refresh they
// would stand until the session's 24h absolute cap, so a Discord role or
// guild-membership change lagged a whole day behind reality for an active
// session. Here a privileged row whose bits are at least
// SESSION_ROLE_RECHECK_SECONDS old re-derives them through the bot-token
// guild-member lookup before the request is authorized:
//
// - Only privileged rows (member or moderator) and only current bearers
//   recheck. An unprivileged row has no access for a Discord change to
//   revoke, and a predecessor-grace read (no status key) must never mint
//   writes — its successor rechecks on its own next request, and an applied
//   recheck rewrites the grace row's bits too, so the grace seconds
//   authorize with the same bits as the successor.
// - Only a definitive Discord answer replaces the bits (a guild-member
//   body, or a 404 with code 10007 for a user who left the guild). An
//   inconclusive lookup
//   keeps the stored bits and only restamps the cadence, so Discord
//   availability never gates a signed-in member or the admin panel; the
//   24h lineage cap remains the hard bound while Discord cannot answer.
// - A refresh failure never fails the request: the store already
//   authenticated the row, so any error here (transport, store, a schema
//   that predates the stamp column) degrades to the stored bits with one
//   class-only warning, never member ids, roles or credentials.
// - An incomplete derivation config (no guild id or bot token) cannot
//   reproduce the login derivation, so it is inconclusive by construction:
//   no lookup, no stamp, the stored bits stand. A blank moderator
//   allowlist is complete config with its login meaning — nobody
//   moderates — and re-derives to moderator=false like login.
//
// Stores without the optional recheck methods (injected test doubles) keep
// the login-only behavior; both real stores implement them.
import { exceptionClass } from "./alerts";
import type { Env } from "./env";
import { isQaFixtureId } from "./qa";
import { parseModeratorRoleIds, recheckGuildRoles } from "./roles";
import type { DbSessionRow, SessionStore } from "./sessions";

export type RoleRecheckConfig = {
  guildId: string;
  botToken: string;
  moderatorRoleIds: string[];
};

/** The bot-credentialed lookup inputs, read from the request bindings. An
 * absent binding reads as undefined at runtime whatever the Env type
 * promises, so normalize to empty: the refresh treats that as incomplete
 * config and keeps the stored bits. */
export function roleRecheckConfigFor(env: Env): RoleRecheckConfig {
  return {
    guildId: env.DISCORD_GUILD_ID ?? "",
    botToken: env.DISCORD_BOT_TOKEN ?? "",
    moderatorRoleIds: parseModeratorRoleIds(env.DISCORD_MODERATOR_ROLE_IDS),
  };
}

/**
 * Returns the row the caller must authorize with: the stored row when no
 * recheck is due or the lookup was inconclusive, the row with re-derived
 * bits after a definitive answer, or null when the row stopped being live
 * during the refresh (revoked/expired between the caller's read and the
 * apply) — the caller then follows its existing no-session path.
 */
export async function refreshSessionRoles(
  store: SessionStore,
  tokenHash: string,
  row: DbSessionRow,
  config: RoleRecheckConfig,
): Promise<DbSessionRow | null> {
  if (!row.member && !row.moderator) return row;
  // QA fixture sessions (staging only) carry fixture bits for synthetic
  // identities Discord has never heard of; re-deriving them would strip a
  // fixture mid-journey on a 404. They keep exactly the bits they issued.
  if (isQaFixtureId(row.userId)) return row;
  try {
    // Incomplete derivation config cannot reproduce the login derivation:
    // no lookup, no stamp, the stored bits stand. Inside the try (and
    // null-safe) so even a malformed config can never fail the request.
    if (!config.guildId?.trim() || !config.botToken?.trim()) return row;
    if (!store.roleRecheckDue || !store.applyRoleRecheck) return row;
    if (!(await store.roleRecheckDue(tokenHash))) return row;
    // get() also admits short predecessor grace; only a current bearer has a
    // status key. Grace reads serve the stored bits for their seconds.
    if (!(await store.statusHash(tokenHash))) return row;
    const bits = await recheckGuildRoles({
      guildId: config.guildId,
      userId: row.userId,
      botToken: config.botToken,
      moderatorRoleIds: config.moderatorRoleIds,
    });
    const applied = await store.applyRoleRecheck(tokenHash, bits);
    if (!applied) {
      // The row rotated, expired or was revoked during the lookup — or a
      // parallel recheck landed first — so these bits were not recorded on
      // it: re-read once and authorize from whatever is actually live (the
      // landed verdict, a grace row, or nothing). If even that read fails,
      // fail closed to no session: the row read before the lookup is known
      // to no longer be live in that form, so it must never be the fallback.
      return await store.get(tokenHash).catch(() => null);
    }
    return bits ? { ...row, member: bits.member, moderator: bits.moderator } : row;
  } catch (err) {
    console.warn("session role recheck failed; keeping stored session bits", {
      exception: exceptionClass(err),
    });
    return row;
  }
}
