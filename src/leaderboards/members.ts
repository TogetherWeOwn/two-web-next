// Member leaderboard: query grammar, ranking read and relative window.
//
// Rank key: count of `going` RSVPs for published or past events inside the season
// window (optionally one normalized game), grouped by member, descending;
// ties break by user id ascending so a relative window is deterministic. Joins
// are never counted. Opted-out and erased members never appear: the inner join
// on `users` drops erased rows, the left join on `profiles` drops opt-outs.
// Rows carry rank + display name + count only: no timestamps, no presence.
import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { containsControlCharacters } from "../admin/validation-shared";
import { keyedMemberRead } from "../member-reads";
import { pgSeasonBound, type SeasonWindow } from "../hotzones/season";
import { OVERALL_CAP, RELATIVE_NEIGHBORS } from "./captions";

// The window constants live in ./captions (the pure caption module both
// twins import); re-exported here so ranking readers keep one import.
export { OVERALL_CAP, RELATIVE_NEIGHBORS };
/**
 * Longest accepted `?activity=` game name (after trimming, in code points,
 * counted before lowercasing — exactly as the event form counts).
 * Aligned to the event-form saved-game max (src/admin/validation-event-form.ts):
 * every game name the form can save is admitted by the filter.
 */
export const ACTIVITY_MAX_LENGTH = 100;

export type MemberScope = "overall" | "relative";
export type ScopeParse = { ok: true; scope: MemberScope } | { ok: false; message: string };

/**
 * `?scope=`: absent/`overall` = full board, `relative` = viewer window.
 * `friends` is deferred (no friend graph exists) and answers 400 naming the
 * deferral; anything else, including the empty string, is 400 as well.
 */
export function parseScopeParam(raw: string | null | undefined): ScopeParse {
  if (raw === null || raw === undefined || raw === "overall") return { ok: true, scope: "overall" };
  if (raw === "relative") return { ok: true, scope: "relative" };
  if (raw === "friends")
    return {
      ok: false,
      message: "The friends scope is deferred: there is no friend graph yet.",
    };
  return { ok: false, message: "Unknown scope" };
}

export type ActivityParse = { ok: true; game: string | null } | { ok: false; message: string };

/**
 * `?activity=`: absent/blank = every game; otherwise one normalized game name
 * (trimmed, lowercased, 1-100 characters, no control characters — the same
 * charset the event form saves). `all` is a game like any other: nothing
 * emits `activity=all` (both board forms label the field "blank for every
 * game"), so a gathering named All filters to its own board. A well-formed
 * name that matches no event is a valid, empty board.
 */
export function parseActivityParam(raw: string | null | undefined): ActivityParse {
  if (raw === null || raw === undefined) return { ok: true, game: null };
  const trimmed = raw.trim();
  // The filter form submits a blank field as `activity=`: that means every game.
  if (trimmed === "") return { ok: true, game: null };
  // Mirror the save-side rule exactly: the event form counts the trimmed name
  // before any lowercasing (src/admin/validation-event-form.ts), so the length
  // check runs here — lowercasing first would expand İ (U+0130) to two code
  // points and 400 a savable 100-character name on both boards.
  const game = trimmed.toLowerCase();
  if ([...trimmed].length > ACTIVITY_MAX_LENGTH || containsControlCharacters(game))
    return { ok: false, message: "Unknown activity" };
  return { ok: true, game };
}

export type RankedMember = { userId: string; username: string; count: number };
export type BoardRow = RankedMember & { rank: number };

type AggregateRow = { user_id: string; username: string; count: number | string };
type RankRow = { user_id: string; rank: number | string };
type WindowRow = AggregateRow & { rank: number | string };

/**
 * The relative window, answered from the database in two bounded statements
 * (a viewer rank lookup, then the window around it): at most
 * 2 * RELATIVE_NEIGHBORS + 2 rows cross the driver no matter how many members
 * rank. Each statement runs under its own keyed-read permit (exactly one
 * statement per permit), and both match the raw-member-owner guard in
 * src/db/read-classification.ts. Rows carry their board rank from SQL: a
 * fetched window cannot self-number, and an unranked viewer (no rank row)
 * gets no rows. Counting, filters and tie order match the overall read.
 */
async function loadRelativeWindow(
  db: Db,
  dateFilter: ReturnType<typeof sql>,
  gameFilter: ReturnType<typeof sql>,
  viewerId: string,
): Promise<BoardRow[]> {
  // No WITH prefix: the read classifier only admits statements that start
  // with SELECT (a CTE can hide a mutation), so both reads nest derived
  // tables instead. Literals, not bound params, for the neighbor bounds: the
  // guard matches the exact statement shape (see OVERALL_CAP below).
  const neighbor = sql.raw(String(RELATIVE_NEIGHBORS));
  const rankRows = (await keyedMemberRead(() =>
    db.execute(sql`
      select ranked.user_id as user_id, ranked.rank as rank
      from (
        select grouped.user_id as user_id,
          row_number() over (order by grouped.count desc, grouped.user_id asc)::int as rank
        from (
          select rsvps.user_id as user_id, count(*)::int as count
          from rsvps
          inner join events on events.id = rsvps.event_id
          inner join users on users.id = rsvps.user_id
          left join profiles on profiles.user_id = rsvps.user_id
          where rsvps.status = 'going'
            and events.status in ('published', 'past')
            and users.member = true
            and (profiles.leaderboard_opt_out is null or profiles.leaderboard_opt_out = false)
            ${dateFilter}
            ${gameFilter}
          group by rsvps.user_id
        ) grouped
      ) ranked
      where ranked.user_id = ${viewerId}
    `),
  )) as unknown as RankRow[];
  const viewerRank = Number(rankRows[0]?.rank);
  if (!Number.isSafeInteger(viewerRank) || viewerRank <= 0) return [];
  const rows = (await keyedMemberRead(() =>
    db.execute(sql`
      select ranked.user_id as user_id, ranked.username as username, ranked.count as count, ranked.rank as rank
      from (
        select grouped.user_id as user_id, grouped.username as username, grouped.count as count,
          row_number() over (order by grouped.count desc, grouped.user_id asc)::int as rank
        from (
          select rsvps.user_id as user_id, users.username as username, count(*)::int as count
          from rsvps
          inner join events on events.id = rsvps.event_id
          inner join users on users.id = rsvps.user_id
          left join profiles on profiles.user_id = rsvps.user_id
          where rsvps.status = 'going'
            and events.status in ('published', 'past')
            and users.member = true
            and (profiles.leaderboard_opt_out is null or profiles.leaderboard_opt_out = false)
            ${dateFilter}
            ${gameFilter}
          group by rsvps.user_id, users.username
        ) grouped
      ) ranked
      where ranked.rank between ${viewerRank} - ${neighbor} and ${viewerRank} + ${neighbor}
      order by ranked.rank asc
    `),
  )) as unknown as WindowRow[];
  return rows.flatMap((row) => {
    if (typeof row.user_id !== "string" || typeof row.username !== "string") return [];
    const count = Number(row.count);
    const rank = Number(row.rank);
    if (!Number.isSafeInteger(count) || count <= 0) return [];
    if (!Number.isSafeInteger(rank) || rank <= 0) return [];
    return [{ userId: row.user_id, username: row.username, count, rank }];
  });
}

/**
 * One keyed read: DB-side GROUP BY + COUNT with a deterministic
 * `count DESC, userId ASC` order. The overall scope caps at OVERALL_CAP via
 * LIMIT; the relative scope answers from a bounded rank lookup plus window
 * read (see loadRelativeWindow) and needs the viewer's id. Counting matches
 * the old per-RSVP fold exactly: only `going` RSVPs for published or past events
 * inside the season window count, with the same `?activity=` game filter,
 * opt-out and member filters. `db = null` (no database configured) yields
 * no rows.
 *
 * Relative rows additionally carry their board rank (BoardRow): the window
 * is already the board slice, so callers use it directly instead of
 * boardRows, which keeps numbering full rankings for the overall scope.
 */
export async function loadMemberRanking(
  db: Db | null,
  window: SeasonWindow,
  game: string | null,
  scope: MemberScope = "overall",
  viewerId?: string,
): Promise<RankedMember[]> {
  if (!db) return [];
  // Raw sql`` interpolation does not serialize Date bounds the way the
  // query builder does (see src/hotzones/aggregates.ts): pass ISO strings so
  // the postgres driver binds them as timestamptz. Year-0 bounds cannot bind
  // (Postgres has no year 0): clamp them to the empty range at 0001-01-01,
  // leaving every other bound untouched. The values change; the statement
  // shape pinned by the member-read classifier does not.
  const dateFilter =
    window.kind === "window"
      ? sql`and events.starts_at >= ${pgSeasonBound(window.start).toISOString()} and events.starts_at < ${pgSeasonBound(window.end).toISOString()}`
      : sql``;
  const gameFilter = game === null ? sql`` : sql`and lower(trim(events.game)) = ${game}`;
  if (scope === "relative") {
    if (!viewerId) throw new Error("loadMemberRanking: the relative scope needs a viewer id");
    return loadRelativeWindow(db, dateFilter, gameFilter, viewerId);
  }
  // LIMIT is a literal cap, not a bound param: the raw-member-owner guard
  // matches the exact statement shape (see src/db/read-classification.ts).
  // Built from OVERALL_CAP so the constant stays the single source of truth.
  const limitClause = sql.raw(`limit ${OVERALL_CAP}`);
  const rows = (await keyedMemberRead(() =>
    db.execute(sql`
      select rsvps.user_id as user_id, users.username as username, count(*)::int as count
      from rsvps
      inner join events on events.id = rsvps.event_id
      inner join users on users.id = rsvps.user_id
      left join profiles on profiles.user_id = rsvps.user_id
      where rsvps.status = 'going'
        and events.status in ('published', 'past')
        and users.member = true
        and (profiles.leaderboard_opt_out is null or profiles.leaderboard_opt_out = false)
        ${dateFilter}
        ${gameFilter}
      group by rsvps.user_id, users.username
      order by count(*) desc, rsvps.user_id asc
      ${limitClause}
    `),
  )) as unknown as AggregateRow[];
  return rows.flatMap((row) => {
    if (typeof row.user_id !== "string" || typeof row.username !== "string") return [];
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count <= 0) return [];
    return [{ userId: row.user_id, username: row.username, count }];
  });
}

/**
 * Rows to render. Overall = the top OVERALL_CAP rows (ranks 1..100).
 * Relative = the viewer plus up to RELATIVE_NEIGHBORS on each side, clamped
 * to the board edges (never more than 2 * RELATIVE_NEIGHBORS + 1 rows); a
 * viewer with no counted RSVP is not on the board and gets no rows.
 */
export function boardRows(
  ranked: RankedMember[],
  scope: MemberScope,
  viewerId: string,
): BoardRow[] {
  const numbered = ranked.map((member, i) => ({ ...member, rank: i + 1 }));
  if (scope === "overall") return numbered.slice(0, OVERALL_CAP);
  const at = ranked.findIndex((member) => member.userId === viewerId);
  if (at < 0) return [];
  return numbered.slice(Math.max(0, at - RELATIVE_NEIGHBORS), at + RELATIVE_NEIGHBORS + 1);
}
