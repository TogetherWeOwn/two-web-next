// Member erasure (TOG-12548). Backs the published deletion promise
// (src/privacy-content.ts "Deletion"): one Discord id, one transaction,
// six member tables: users, profiles, rsvps, web_sessions, the session
// predecessor-grace table, and join_attempts. Seats the member held go to
// the waitlist in the same transaction. Authorship columns (events.created_by,
// featured_contents.created_by) and the append-only audit tables are
// deliberately out of scope — see docs/member-erasure.md.
import { inArray } from "drizzle-orm";
import { events } from "./db/admin-schema";
import { drizzleOver, type UnsafeClient } from "./db/proxy";
import { lockWaitlist, promoteWaitlist } from "./events/waitlist";

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
 * each pass deleted, in order. On apply results `passes ===
 * deletesPerPass.length` and `web_sessions === sum(deletesPerPass)` hold;
 * dry-run returns `passes: 0` with an empty array next to the counted
 * `web_sessions`. Numbers only, never ids.
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

/** Minimal postgres.js surface the erasure needs: templated queries + begin,
 * plus `unsafe` for the Drizzle bridge the waitlist promotion runs on. */
export type ErasureTx = (<T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>) &
  UnsafeClient;

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

/** Hand each seat the member released to its waitlist, like the RSVP verbs do
 * on a withdrawal. Runs behind the event row locks eraseMember takes first. */
async function promoteFreedSeats(
  tx: ErasureTx,
  released: { event_id: number; status: string }[],
): Promise<void> {
  const ids = [...new Set(released.filter((r) => r.status === "going").map((r) => r.event_id))];
  if (ids.length === 0) return;
  const db = drizzleOver(tx);
  const seated = await db.select().from(events).where(inArray(events.id, ids)).orderBy(events.id);
  // Finish every head-row wait before reading the clock, then judge expiry
  // and stamp promotions on that one database instant, like the RSVP verbs.
  for (const ev of seated) await lockWaitlist(db, ev.id);
  // Epoch milliseconds, not a timestamptz: a client Drizzle has wrapped
  // parses timestamps as strings, while the CLI's own client returns Dates.
  const [clock] = await tx<
    { ms: number }[]
  >`select extract(epoch from clock_timestamp())::float8 * 1000 as ms`;
  const now = new Date(clock!.ms);
  for (const ev of seated) await promoteWaitlist(db, ev, () => now);
}

/**
 * Erase one member's rows. Dry-run counts only and writes nothing; apply
 * deletes all six member tables in one transaction, promotes the waitlist of
 * every event where the member held a seat, and returns rows removed plus the
 * session-chase pass forensics. The id is validated before any
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
    // Lock the member's events in id order, the RSVP verbs' event-then-RSVP
    // order. The rsvps sync-revision trigger would otherwise take these locks
    // in delete order, and the promotion below needs them held.
    await tx`select id from events
      where id in (select event_id from rsvps where user_id = ${discordId})
      order by id for update`;
    const users = await tx`delete from users where id = ${discordId} returning 1`;
    const profiles = await tx`delete from profiles where user_id = ${discordId} returning 1`;
    const rsvps = await tx<
      { event_id: number; status: string }[]
    >`delete from rsvps where user_id = ${discordId} returning event_id, status`;
    // The delete and each promotion advance the event's sync_revision through
    // the rsvps trigger, so the reconcile cron re-syncs Discord.
    await promoteFreedSeats(tx, rsvps);
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
