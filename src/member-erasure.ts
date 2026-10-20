// Member erasure (TOG-12548). Backs the published deletion promise
// (src/privacy-content.ts "Deletion"): one Discord id, one transaction,
// six member tables: users, profiles, rsvps, web_sessions, the session
// predecessor-grace table, and join_attempts. Authorship columns (events.created_by,
// featured_contents.created_by) and the append-only audit tables are
// deliberately out of scope — see docs/member-erasure.md.
export const DISCORD_ID_RE = /^[1-9]\d{0,19}$/;

export class InvalidMemberIdError extends Error {
  constructor(received: unknown) {
    super(
      typeof received === "string" && received.length > 0
        ? "Refusing: malformed Discord id."
        : "Refusing: a Discord id is required.",
    );
    this.name = "InvalidMemberIdError";
  }
}

/** Discord snowflake: decimal digits, at most 20 (a 64-bit id). */
export function isValidDiscordId(id: unknown): id is string {
  return typeof id === "string" && DISCORD_ID_RE.test(id);
}

export function assertDiscordId(id: unknown): asserts id is string {
  if (!isValidDiscordId(id)) throw new InvalidMemberIdError(id);
}

export type ErasureCounts = {
  users: number;
  profiles: number;
  rsvps: number;
  web_sessions: number;
  web_session_grace: number;
  join_attempts: number;
};

/**
 * Erasure result: per-table counts plus session-chase forensics. `passes` is
 * the number of chase passes executed and `deletesPerPass` the session rows
 * each pass deleted, in order; `passes === deletesPerPass.length` and
 * `web_sessions === sum(deletesPerPass)` always hold. Numbers only, never ids.
 */
export type ErasureResult = ErasureCounts & {
  passes: number;
  deletesPerPass: number[];
};

export const ERASURE_TABLES = [
  "users",
  "profiles",
  "rsvps",
  "web_sessions",
  "web_session_grace",
  "join_attempts",
] as const;

export type ErasureTable = (typeof ERASURE_TABLES)[number];

/** Minimal postgres.js surface the erasure needs: templated queries + begin. */
export type ErasureTx = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

export type ErasureSql = ErasureTx & {
  begin: <T>(fn: (tx: ErasureTx) => Promise<T>) => Promise<T>;
};

const zeroCounts = (): ErasureCounts => ({
  users: 0,
  profiles: 0,
  rsvps: 0,
  web_sessions: 0,
  web_session_grace: 0,
  join_attempts: 0,
});

/** Per-table row counts for one member. Reads only; never row contents. */
export async function countMemberRows(sql: ErasureTx, discordId: string): Promise<ErasureCounts> {
  assertDiscordId(discordId);
  const counts = zeroCounts();
  const [u] = await sql<
    { n: number }[]
  >`select count(*)::int as n from users where id = ${discordId}`;
  const [p] = await sql<
    { n: number }[]
  >`select count(*)::int as n from profiles where user_id = ${discordId}`;
  const [r] = await sql<
    { n: number }[]
  >`select count(*)::int as n from rsvps where user_id = ${discordId}`;
  const [s] = await sql<
    { n: number }[]
  >`select count(*)::int as n from web_sessions where user_id = ${discordId}`;
  const [g] = await sql<
    { n: number }[]
  >`select count(*)::int as n from web_session_grace where user_id = ${discordId}`;
  const [j] = await sql<
    { n: number }[]
  >`select count(*)::int as n from join_attempts where discord_id = ${discordId}`;
  counts.users = u?.n ?? 0;
  counts.profiles = p?.n ?? 0;
  counts.rsvps = r?.n ?? 0;
  counts.web_sessions = s?.n ?? 0;
  counts.web_session_grace = g?.n ?? 0;
  counts.join_attempts = j?.n ?? 0;
  return counts;
}

/**
 * Erase one member's rows. Dry-run counts only and writes nothing; apply
 * deletes all six member tables in one transaction and returns rows removed
 * plus the session-chase pass forensics. The id is validated before any
 * query runs.
 */
export async function eraseMember(
  sql: ErasureSql,
  discordId: string,
  opts: { dryRun: boolean },
): Promise<ErasureResult> {
  assertDiscordId(discordId);
  if (opts.dryRun) {
    const counts = await countMemberRows(sql, discordId);
    return { ...counts, passes: 0, deletesPerPass: [] };
  }
  return sql.begin(async (tx) => {
    const counts = zeroCounts();
    const users = await tx`delete from users where id = ${discordId} returning 1`;
    const profiles = await tx`delete from profiles where user_id = ${discordId} returning 1`;
    const rsvps = await tx`delete from rsvps where user_id = ${discordId} returning 1`;
    // An in-flight rotation can replace a locked source row after this
    // DELETE's statement snapshot. Recount with a fresh snapshot and delete
    // its successor, like revokeMemberSessions does for revocation stamps.
    // The loop has no pass cap on purpose: a bounded cap throws away (by
    // rolling back) every row deleted so far, so sustained rotation always
    // outlasts it while the victim stays signed in. Each pass deletes every
    // row in a fresh snapshot, so a rotation racing a deleted row parks on
    // its lock and then fails on the missing source without minting; only
    // rotations already holding a source lock can still commit a successor,
    // bounding each pass's miss to the instantaneously in-flight frontier.
    // Passes therefore chase a shrinking frontier until one pass observes
    // quiescence. Database errors still propagate and roll the whole
    // erasure back.
    let sessions = 0;
    const deletesPerPass: number[] = [];
    for (;;) {
      const deleted = await tx`delete from web_sessions where user_id = ${discordId} returning 1`;
      sessions += deleted.length;
      deletesPerPass.push(deleted.length);
      const [remaining] = await tx<
        { n: number }[]
      >`select count(*)::int as n from web_sessions where user_id = ${discordId}`;
      if ((remaining?.n ?? 0) === 0) break;
    }
    const grace = await tx`delete from web_session_grace where user_id = ${discordId} returning 1`;
    const attempts =
      await tx`delete from join_attempts where discord_id = ${discordId} returning 1`;
    counts.users = users.length;
    counts.profiles = profiles.length;
    counts.rsvps = rsvps.length;
    counts.web_sessions = sessions;
    counts.web_session_grace = grace.length;
    counts.join_attempts = attempts.length;
    return { ...counts, passes: deletesPerPass.length, deletesPerPass };
  });
}
