// Your upcoming game nights (S4): the self-profile's own RSVP answers joined
// to published upcoming events. One keyed statement, capped at
// PROFILE_UPCOMING_LIMIT, soonest first; waitlisted rows carry their 1-based
// FIFO position. Self-only by construction: callers resolve it only when
// viewer == member, and the captured owner is always the viewer, so own reads
// stay unaudited.
import { sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { memberReadDb } from "../db/member-reads";
import { keyedMemberRead } from "../member-reads";

/** Pinned upcoming-list cap: one bounded read, exactly this many rows max. */
export const PROFILE_UPCOMING_LIMIT = 10;

/** One row the upcoming read resolves for the viewing member. */
export type UpcomingGameNight = {
  eventKey: string;
  title: string;
  startsAt: Date;
  timezone: string;
  location: string | null;
  status: "going" | "waitlisted";
  /** 1-based FIFO position; set iff status is waitlisted, else null. */
  waitlistPosition: number | null;
};

export type UpcomingGameNightsSource = (memberId: string) => Promise<UpcomingGameNight[] | null>;

type UpcomingRow = {
  user_id: unknown;
  event_key: unknown;
  title: unknown;
  starts_at: unknown;
  timezone: unknown;
  location: unknown;
  status: unknown;
  waitlist_position: unknown;
};

const dateOrNull = (value: unknown): Date | null => {
  if (!(value instanceof Date) && (typeof value !== "string" || value === "")) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

/**
 * One statement: the member's own going/waitlisted answers joined to
 * published events that have not ended yet (the feed scope: ends_at >= now,
 * see listFeed), soonest first with the id tie-break, capped at
 * PROFILE_UPCOMING_LIMIT. The waitlist position counts strictly-earlier
 * waitlisted rows under the same FIFO key the waitlist window helper orders
 * by (created_at, coalesce(legacy_id, id), id), so it agrees with
 * waitlistPosition exactly. A null db reads as unknown (null), never as an
 * empty list; failures propagate so the read boundary refuses closed.
 */
export async function readProfileUpcoming(
  db: Db | null,
  memberId: string,
  now: Date = new Date(),
): Promise<UpcomingGameNight[] | null> {
  if (!db) return null;
  // LIMIT is a literal cap, not a bound param: the raw-member-owner guard
  // matches the exact statement shape (see src/db/read-classification.ts).
  // Built from PROFILE_UPCOMING_LIMIT so the constant stays the single source
  // of truth. The now bound is an ISO string: raw sql`` interpolation does
  // not serialize Date bounds (see src/leaderboards/members.ts).
  // Reject both unsupported boundaries before LIMIT, so imports cannot crowd
  // out usable links. PostgreSQL's earliest finite timestamp fits in JS Date;
  // its latest does not, so pin the JS upper bound as well as isfinite().
  const limitClause = sql.raw(`limit ${PROFILE_UPCOMING_LIMIT}`);
  const connection = memberReadDb(db);
  const rows = (await keyedMemberRead(() =>
    connection.execute(sql`
      select r.user_id as user_id, e.event_key as event_key, e.title as title,
        e.starts_at as starts_at, e.timezone as timezone, e.location as location,
        r.status as status,
        case when r.status = 'waitlisted' then (
          select count(*)::int + 1
          from rsvps as w
          where w.event_id = e.id and w.status = 'waitlisted'
            and (w.created_at, coalesce(w.legacy_id, w.id), w.id)
              < (r.created_at, coalesce(r.legacy_id, r.id), r.id)
        ) else null end as waitlist_position
      from rsvps as r
      inner join events as e on e.id = r.event_id
      where r.user_id = ${memberId}
        and r.status in ('going', 'waitlisted')
        and e.status = 'published'
        and isfinite(e.starts_at) and isfinite(e.ends_at)
        and e.starts_at <= '275760-09-13 00:00:00+00'::timestamptz
        and e.ends_at <= '275760-09-13 00:00:00+00'::timestamptz
        and e.ends_at >= ${now.toISOString()}
      order by e.starts_at asc, e.id asc
      ${limitClause}
    `),
  )) as unknown as UpcomingRow[];
  return rows.flatMap((row): UpcomingGameNight[] => {
    // The query filters to the viewer; a row for anyone else is dropped, never
    // rendered into another member's self-view.
    if (typeof row.user_id !== "string" || row.user_id !== memberId) return [];
    if (typeof row.event_key !== "string" || typeof row.title !== "string") return [];
    const startsAt = dateOrNull(row.starts_at);
    if (!startsAt) return [];
    if (typeof row.timezone !== "string") return [];
    if (row.location !== null && typeof row.location !== "string") return [];
    if (row.status !== "going" && row.status !== "waitlisted") return [];
    const night = {
      eventKey: row.event_key,
      title: row.title,
      startsAt,
      timezone: row.timezone,
      location: row.location,
    };
    if (row.status === "going") {
      if (row.waitlist_position !== null) return [];
      return [{ ...night, status: row.status, waitlistPosition: null }];
    }
    const position = row.waitlist_position;
    if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1) return [];
    return [{ ...night, status: row.status, waitlistPosition: position }];
  });
}
