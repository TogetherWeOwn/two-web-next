import { sql } from "drizzle-orm";
import { exceptionClass } from "../alerts";
import type { Db } from "../db/index";
import { memberReadDb } from "../db/member-reads";
import { keyedMemberRead, MemberReadRefused } from "../member-reads";
import { dateOrNull } from "./stats";

// Self-view attended-history window: the read fetches one row past the
// display cap so truncation is detected, never inferred from the cap (the
// milestones cap+1 precedent in stats.ts).
export const ATTENDED_HISTORY_LIMIT = 5;
const ATTENDED_HISTORY_READ = ATTENDED_HISTORY_LIMIT + 1;

export type AttendedNight = {
  eventKey: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /** IANA zone the night renders its date in (falls back to UTC when invalid). */
  timezone: string;
};
export type AttendedHistory = { total: number; nights: AttendedNight[] };

// count(*) over () arrives as bigint, text or number depending on the driver
// path; anything unparseable reads as zero rather than refusing the page.
const countOrZero = (value: unknown): number => {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

// One bounded keyed read of the actor's own answers joined to published past
// events: going answers on ended events with status published/past, newest
// first with the past-archive id-desc tiebreak. Attended means ended
// (ends_at < now); cancelled/draft events, non-going answers, withdrawn
// answers (no row) and upcoming answers never match. The isfinite window
// guard (the listCalendarPast precedent) keeps unrenderable infinity import
// rows out of the count and out of limit slots; without it such a row sorts
// first, inflates the total, then drops post-slice and hides a valid night.
// The timezone projection lets both twins render each night's date in its
// event zone, like the past archive, instead of UTC. A drizzle select cannot
// carry count(*) over () (non-Column projections are refused by the
// classifier), so this is one raw statement with a window total, exempted by
// exact shape in rawMemberOwner. Every returned row belongs to the bound
// user, so the captured owners equal the viewer and the read stays unaudited.
//
// An ordinary database error degrades to null (the section hides, like a
// missing stats block) instead of 503ing the already-read profile. Only
// contract refusals propagate: a swallowed refusal would hide a programming
// error behind a missing section. The warn is class-only, never a driver
// message (it can carry a connection string) or member data.
export async function readAttendedHistory(
  db: Pick<Db, "execute">,
  userId: string,
): Promise<AttendedHistory | null> {
  const connection = memberReadDb(db as Db);
  const now = new Date().toISOString();
  let rows;
  try {
    rows = await keyedMemberRead(() =>
      connection.execute(sql`
      select rsvps.user_id, events.event_key, events.title, events.starts_at, events.ends_at, events.timezone,
        count(*) over () as total
      from rsvps inner join events on events.id = rsvps.event_id
      where rsvps.user_id = ${userId} and rsvps.status = 'going'
        and events.ends_at < ${now} and events.status in ('published', 'past')
        and isfinite(events.starts_at) and isfinite(events.ends_at)
      order by events.starts_at desc, events.id desc
      limit ${sql.raw(String(ATTENDED_HISTORY_READ))}
    `),
    );
  } catch (err) {
    if (err instanceof MemberReadRefused) throw err;
    console.warn("Attended history unavailable; hiding the section.", {
      exception: exceptionClass(err),
    });
    return null;
  }
  const first = rows[0];
  return {
    total: first ? countOrZero(first.total) : 0,
    // Raw reads return instants as text on some driver paths; coerce like
    // the milestones reader and drop rows with unparseable instants. A
    // missing zone reads as UTC; a present-but-invalid zone is carried and
    // the renderers fall back to UTC when Intl refuses it.
    nights: rows.slice(0, ATTENDED_HISTORY_LIMIT).flatMap((row) => {
      const startsAt = dateOrNull(row.starts_at);
      const endsAt = dateOrNull(row.ends_at);
      const timezone =
        typeof row.timezone === "string" && row.timezone !== "" ? row.timezone : "UTC";
      return startsAt && endsAt
        ? [
            {
              eventKey: String(row.event_key),
              title: String(row.title),
              startsAt,
              endsAt,
              timezone,
            },
          ]
        : [];
    }),
  };
}
