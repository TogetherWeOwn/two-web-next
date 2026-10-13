// Member leaderboard: query grammar, ranking read and relative window.
//
// Rank key: count of `going` RSVPs for published events inside the season
// window (optionally one normalized game), grouped by member, descending;
// ties break by user id ascending so a relative window is deterministic. Joins
// are never counted. Opted-out and erased members never appear: the inner join
// on `users` drops erased rows, the left join on `profiles` drops opt-outs.
// Rows carry rank + display name + count only: no timestamps, no presence.
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { events, rsvps } from "../db/admin-schema";
import type { Db } from "../db/index";
import { profiles, users } from "../db/schema";
import { keyedMemberRead } from "../member-reads";
import type { SeasonWindow } from "../hotzones/season";

/** Neighbors shown above and below the viewer in the relative scope. */
export const RELATIVE_NEIGHBORS = 5;
/** Longest accepted `?activity=` game name (after trimming). */
export const ACTIVITY_MAX_LENGTH = 64;

const ACTIVITY_RE = /^[a-z0-9 _-]+$/;

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
 * `?activity=`: absent/blank/`all` = every game; otherwise one normalized game name
 * (trimmed, lowercased, 1-64 characters of `[a-z0-9 _-]`). A well-formed name
 * that matches no event is a valid, empty board.
 */
export function parseActivityParam(raw: string | null | undefined): ActivityParse {
  if (raw === null || raw === undefined) return { ok: true, game: null };
  const game = raw.trim().toLowerCase();
  // The filter form submits a blank field as `activity=`: that means every game.
  if (game === "" || game === "all") return { ok: true, game: null };
  if (game.length > ACTIVITY_MAX_LENGTH || !ACTIVITY_RE.test(game))
    return { ok: false, message: "Unknown activity" };
  return { ok: true, game };
}

export type RankedMember = { userId: string; username: string; count: number };
export type BoardRow = RankedMember & { rank: number };

/**
 * One keyed read: a row per counted going RSVP, folded to counts here. The
 * member-read boundary needs plain column projections, so aggregation stays in
 * application code. `db = null` (no database configured) yields no rows.
 */
export async function loadMemberRanking(
  db: Db | null,
  window: SeasonWindow,
  game: string | null,
): Promise<RankedMember[]> {
  if (!db) return [];
  const rows = await keyedMemberRead(() =>
    db
      .select({ userId: rsvps.userId, id: users.id, username: users.username })
      .from(rsvps)
      .innerJoin(events, eq(events.id, rsvps.eventId))
      .innerJoin(users, eq(users.id, rsvps.userId))
      .leftJoin(profiles, eq(profiles.userId, rsvps.userId))
      .where(
        and(
          eq(rsvps.status, "going"),
          eq(events.status, "published"),
          eq(users.member, true),
          or(isNull(profiles.leaderboardOptOut), eq(profiles.leaderboardOptOut, false)),
          window.kind === "window" ? gte(events.startsAt, window.start) : undefined,
          window.kind === "window" ? lt(events.startsAt, window.end) : undefined,
          game === null ? undefined : sql`lower(trim(${events.game})) = ${game}`,
        ),
      ),
  );
  const byUser = new Map<string, RankedMember>();
  for (const row of rows) {
    const entry = byUser.get(row.userId);
    if (entry) entry.count += 1;
    else byUser.set(row.userId, { userId: row.userId, username: row.username, count: 1 });
  }
  return [...byUser.values()].sort(
    (a, b) => b.count - a.count || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
}

/**
 * Rows to render. Overall = the whole ranking. Relative = the viewer plus up
 * to RELATIVE_NEIGHBORS on each side, clamped to the board edges (never more
 * than 2 * RELATIVE_NEIGHBORS + 1 rows); a viewer with no counted RSVP is not
 * on the board and gets no rows.
 */
export function boardRows(
  ranked: RankedMember[],
  scope: MemberScope,
  viewerId: string,
): BoardRow[] {
  const numbered = ranked.map((member, i) => ({ ...member, rank: i + 1 }));
  if (scope === "overall") return numbered;
  const at = ranked.findIndex((member) => member.userId === viewerId);
  if (at < 0) return [];
  return numbered.slice(Math.max(0, at - RELATIVE_NEIGHBORS), at + RELATIVE_NEIGHBORS + 1);
}
