// The one-click web-to-Discord join journey (W6).
//
// Ports two-web JoinController's funnel contract onto the Workers stack:
//   GET  /join            — the journey page (one-click button + invite fallback)
//   GET  /join/discord    — throttle, then 302 to Discord with identify+guilds.join
//   GET  /join/callback   — throttle, exchange, synchronous bot add, sign-in
//
// Three deliberate differences from legacy, each pinned by tests:
//   1. The synchronous bot call goes to Discord's own
//      PUT /guilds/{guild}/members/{user} with the bot token (the same call the
//      /auth/discord flow already makes), not to a bot HMAC endpoint: the bot
//      rewrite is Rust with its contract pending, and the token-hygiene property
//      — the live member token is used once in this stack frame and never lands
//      in a queue table, a row or a log — holds either way.
//   2. The join page and the journey state carry a signed `join_source` /
//      `join_next` cookie pair instead of the Laravel session (there is no
//      server session yet at that point): `source` is attribution-only and
//      validated against the legacy pattern; `next` must pass the same
//      open-redirect guard as legacy SafeRedirect.
//   3. The throttle is Postgres (`web_throttle_hits`), not the cache store: the
//      funnel floor must not depend on a cache that is the database everywhere
//      shipped, and Workers isolates share nothing in memory — Postgres is the
//      only coordination point, so behaviour is identical across isolates.
//
// Token hygiene (the W6 acceptance test): the only values written anywhere are
// outcome, source, request_id and discord_id. The OAuth/token-exchange response
// bodies and exception messages can quote the live token, so none of them is
// ever a recordAttempt parameter and none is ever logged.
import { addGuildMember, type JoinResult } from "../discord";
import type { Sql } from "../sessions";

export const JOIN_OUTCOMES = ["added", "already_member", "error", "denied", "degraded"] as const;
export type JoinOutcome = (typeof JOIN_OUTCOMES)[number];

/** Legacy 10/min budget on /join/discord + /join/callback (one shared bucket). */
export const JOIN_THROTTLE_PER_MINUTE = 10;
export const JOIN_THROTTLE_BUCKET = "join";

/**
 * Legacy join_source validation (JoinController::rememberSource): starts
 * alnum, then up to 63 of [a-z0-9:_-]. Anything else leaves no trace.
 */
export function sanitizeSource(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(raw) ? raw : null;
}

/**
 * Legacy SafeRedirect::safe: the value survives only when it is a same-origin
 * path — starts with exactly one `/`, no `//`, no backslash, no scheme.
 * Hostile values leave no trace and the callback keeps the default landing.
 *
 * Control bytes (notably NUL) are rejected too: a surviving value lands in
 * the callback's Location header, where Headers.set throws on them and turns
 * an otherwise successful login into a 500.
 */
export function safeNext(raw: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  if (typeof raw !== "string" || raw === "" || /[\s\x00-\x1f\x7f]/.test(raw)) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  try {
    const u = new URL(raw, "https://join.invalid");
    if (u.origin !== "https://join.invalid") return null;
  } catch {
    return null;
  }
  return raw;
}

export type ThrottleVerdict = { limited: false } | { limited: true; retryAfter: number };

/**
 * Fixed-window throttle: count rows in this bucket in the last 60 s; over
 * budget refuses before the token exchange runs. A missing store degrades to
 * allow — refusing the funnel top on a DB outage is worse than a missed count
 * (legacy funnel.php made the same call for the leaves: no throttle at all
 * rather than a cache-backed one that 500s when the database is down).
 */
export async function checkJoinThrottle(
  sql: Sql | null,
  bucket: string,
  max: number,
): Promise<ThrottleVerdict> {
  if (!sql) return { limited: false };
  // The native postgres.js store supports transactions; the session SQL seam
  // deliberately exposes only the statements needed by session stores.
  const store = sql as Sql & {
    begin: (run: (tx: Sql) => Promise<ThrottleVerdict>) => Promise<ThrottleVerdict>;
  };
  const verdict = await store.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`web-throttle:${bucket}`}, 0))`;
    // now() is transaction-start time, which can precede a long lock wait.
    const rows = await tx<{ n: number; wait: number }[]>`
      SELECT count(*)::int AS n,
        coalesce(ceil(extract(epoch FROM (min(at) + interval '60 seconds' - clock_timestamp()))), 1)::int AS wait
      FROM web_throttle_hits WHERE bucket = ${bucket} AND at > clock_timestamp() - interval '60 seconds'`;
    const r = rows[0];
    if (r && r.n >= max) return { limited: true, retryAfter: Math.max(1, r.wait) };
    await tx`INSERT INTO web_throttle_hits (bucket, at) VALUES (${bucket}, clock_timestamp())`;
    return { limited: false };
  });
  // Global expiry cleanup must not prolong the per-bucket admission lock.
  if (!verdict.limited)
    await sql`DELETE FROM web_throttle_hits WHERE at < now() - interval '5 minutes'`;
  return verdict;
}

// Runtime DDL for the join tables, mirroring sessions.ts MIGRATION: the same
// shape as drizzle/1000_join-attempts-throttle.sql, create-if-not-exists so a
// Worker that reaches a migrated database is a no-op and one that reaches a
// fresh staging database self-heals. The drizzle file stays the canonical
// migration for the `db:migrate` path; this is the funnel-floor backstop.
// The import-only legacy_id key (drizzle/1012) is deliberately absent here:
// the admin viewer selects explicit columns so both shapes stay readable, and
// keeping the bootstrap identical to 1000 means 1012 still applies cleanly on
// bootstrapped databases.
const JOIN_MIGRATION = [
  `create table if not exists join_attempts (
    id bigserial primary key,
    outcome varchar(16) not null,
    source varchar(64),
    request_id text,
    discord_id text,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists web_throttle_hits (
    id bigserial primary key,
    bucket text not null,
    at timestamptz not null default now()
  )`,
  `create index if not exists join_attempts_created_at_idx on join_attempts (created_at)`,
  `create index if not exists web_throttle_hits_bucket_at_idx on web_throttle_hits (bucket, at)`,
];

export async function migrateJoin(sql: Sql): Promise<void> {
  for (const stmt of JOIN_MIGRATION) await sql.unsafe(stmt);
}

/** One queryable row per terminal join path. Null store = no-op (funnel stays up). */
export async function recordAttempt(
  sql: Sql | null,
  attempt: {
    outcome: JoinOutcome;
    source: string | null;
    requestId: string | null;
    discordId: string | null;
  },
): Promise<void> {
  if (!sql) return;
  await sql`INSERT INTO join_attempts (outcome, source, request_id, discord_id)
    VALUES (${attempt.outcome}, ${attempt.source}, ${attempt.requestId}, ${attempt.discordId})`;
}

export type BotAdd = (
  guildId: string,
  userId: string,
  accessToken: string,
) => Promise<{
  result: JoinResult;
  requestId: string | null;
}>;

/** The production bot call: Discord's own add-member endpoint with the bot token. */
export function liveBotAdd(botToken: string): BotAdd {
  return async (guildId, userId, accessToken) => ({
    result: await addGuildMember(guildId, userId, accessToken, botToken),
    requestId: null,
  });
}

export type JoinFinish =
  | {
      kind: "signed_in";
      outcome: JoinOutcome;
      redirect: string;
      requestId: string | null;
      discordId: string;
    }
  | { kind: "recoverable"; outcome: JoinOutcome; requestId: string | null };

/**
 * The synchronous tail of the callback: one bot attempt owns the live token,
 * then the frame drops it. Outcomes mirror the legacy JoinOutcome enum:
 * added / already_member → sign in; anything the bot refuses or any transport
 * failure → degraded (sign-in succeeds, invite fallback offered); the callback
 * never stores the token, never logs it, never queues it.
 */
export async function finishJoin(
  bot: BotAdd,
  guildId: string,
  userId: string,
  accessToken: string,
  next: string | null,
): Promise<JoinFinish> {
  let result: JoinResult;
  let requestId: string | null = null;
  try {
    const answer = await bot(guildId, userId, accessToken);
    result = answer.result;
    requestId = answer.requestId;
  } catch {
    return { kind: "recoverable", outcome: "degraded", requestId: null };
  }
  if (result === "failed") return { kind: "recoverable", outcome: "degraded", requestId };
  const outcome: JoinOutcome = result === "joined" ? "added" : "already_member";
  const notice = result === "joined" ? "joined" : "already_member";
  return {
    kind: "signed_in",
    outcome,
    redirect: next ?? `/?n=${notice}`,
    requestId,
    discordId: userId,
  };
}
