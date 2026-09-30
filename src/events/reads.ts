// Public event reads (W8). Published-only unless the caller is a moderator.
import { and, asc, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index";
import { events, rsvps } from "../db/admin-schema";
import { users } from "../db/schema";
import { EVENTS_PAST_DRAWER_LIMIT, escapeLikeTerm, PAST_EVENTS_PAGE_SIZE } from "../islands/contracts";

export type PublicEvent = typeof events.$inferSelect & { goingCount: number };

export const PAGE_SIZE = PAST_EVENTS_PAGE_SIZE;
export const JSON_DEFAULT_LIMIT = PAST_EVENTS_PAGE_SIZE;
export const JSON_MAX_LIMIT = 100;

async function withGoing(db: Db, rows: (typeof events.$inferSelect)[]): Promise<PublicEvent[]> {
  if (rows.length === 0) return [];
  const counts = await db
    .select({ eventId: rsvps.eventId, n: count() })
    .from(rsvps)
    .where(and(inArray(rsvps.eventId, rows.map((r) => r.id)), eq(rsvps.status, "going")))
    .groupBy(rsvps.eventId);
  const by = new Map(counts.map((c) => [c.eventId, Number(c.n)]));
  return rows.map((r) => ({ ...r, goingCount: by.get(r.id) ?? 0 }));
}

/** Title/description substring match; SQL wildcards in the query match themselves. */
export function searchCondition(q: string | null): SQL | undefined {
  if (!q) return undefined;
  const term = `%${escapeLikeTerm(q)}%`;
  return or(ilike(events.title, term), ilike(events.description, term));
}

/**
 * The EventsCalendar visibility clause (legacy `visible()`): drafts are
 * invisible to non-moderators — inside a search too, so a member searching a
 * draft's title learns nothing — and a non-blank search narrows title OR
 * description via a bound, wildcard-escaped ilike. Cancelled rows stay listed
 * (somebody RSVP'd to them); the draft filter is the only status gate.
 */
export interface CalendarReadOpts {
  includeDrafts?: boolean;
  search?: string | null;
}

function calendarVisible(opts: CalendarReadOpts): SQL | undefined {
  const clauses: SQL[] = [];
  if (!opts.includeDrafts) clauses.push(sql`${events.status} != 'draft'`);
  const condition = searchCondition(opts.search?.trim() ?? null);
  if (condition) clauses.push(condition);
  return clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : and(...clauses);
}

/** Upcoming = visible and not yet ended, soonest first (legacy `upcoming()`). */
export async function listUpcoming(db: Db, now = new Date(), opts: CalendarReadOpts = {}): Promise<PublicEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(calendarVisible(opts), gte(events.endsAt, now)))
    .orderBy(asc(events.startsAt));
  return withGoing(db, rows);
}

/** Identity wins over display eligibility: hidden, renamed and paginated rows still suppress Discord copies. */
export async function persistedDiscordIds(db: Db, candidates: string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ discordEventId: events.discordEventId })
    .from(events)
    .where(inArray(events.discordEventId, candidates));
  return new Set(rows.map((r) => r.discordEventId).filter((id): id is string => id !== null));
}

/**
 * The past drawer (legacy `past()`): visible rows that have ended, most recent
 * first, capped at twenty — the same cap the search-log count reads as "20".
 */
export async function listCalendarPast(
  db: Db,
  now = new Date(),
  opts: CalendarReadOpts = {},
): Promise<PublicEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(calendarVisible(opts), lt(events.endsAt, now)))
    .orderBy(desc(events.startsAt), desc(events.id))
    .limit(EVENTS_PAST_DRAWER_LIMIT);
  return withGoing(db, rows);
}

/** Past archive: ended (published-then-closed or already `past`), newest first, 20/page. */
export async function listPast(db: Db, page: number, now = new Date(), q: string | null = null): Promise<{ rows: PublicEvent[]; hasMore: boolean; totalPages: number }> {
  const archived = and(or(eq(events.status, "past"), and(eq(events.status, "published"), lt(events.endsAt, now))), searchCondition(q));
  const [total] = await db.select({ n: count() }).from(events).where(archived);
  const rows = await db
    .select()
    .from(events)
    .where(archived)
    .orderBy(desc(events.startsAt), desc(events.id))
    .limit(PAGE_SIZE + 1)
    .offset((Math.max(1, page) - 1) * PAGE_SIZE);
  return {
    rows: await withGoing(db, rows.slice(0, PAGE_SIZE)),
    hasMore: rows.length > PAGE_SIZE,
    totalPages: Math.ceil(Number(total?.n ?? 0) / PAGE_SIZE),
  };
}

export async function getPublicEvent(db: Db, key: string): Promise<PublicEvent | null> {
  const [row] = await db.select().from(events).where(eq(events.eventKey, key));
  if (!row) return null;
  return (await withGoing(db, [row]))[0] ?? null;
}

/** Viewer answer for the RSVP island (TOG-9839 slice 2): the caller's own row
 * only — keyed on the session user, never another member's. Null when the
 * viewer has not answered. Waitlist copy uses the null-position fallback:
 * there is no position column and no waitlist-count query. */
export type ViewerRsvp = { status: string; syncedToDiscordAt: Date | null };
export async function getViewerRsvp(db: Db, eventId: number, userId: string): Promise<ViewerRsvp | null> {
  const [row] = await db
    .select({ status: rsvps.status, syncedToDiscordAt: rsvps.syncedToDiscordAt })
    .from(rsvps)
    .where(and(eq(rsvps.eventId, eventId), eq(rsvps.userId, userId)));
  return row ?? null;
}

export type EventAttendee = { id: string; name: string };

/** Member-only projection, never part of PublicEvent or the feeds/JSON. */
export async function listGoingAttendees(db: Db, eventId: number): Promise<EventAttendee[]> {
  // Legacy answer-time order, not the admin roster's most-recent-update order.
  // Partial select/join/orderBy: https://orm.drizzle.team/docs/select
  const rows = await db
    .select({ id: users.id, name: users.username })
    .from(rsvps)
    .innerJoin(users, eq(rsvps.userId, users.id))
    .where(and(eq(rsvps.eventId, eventId), eq(rsvps.status, "going")))
    .orderBy(asc(rsvps.createdAt), asc(rsvps.id));
  return rows.filter((row) => Boolean(row.name));
}

/** Collection for /events.json: offset paging, statuses visible to the viewer only. */
export async function listJson(
  db: Db,
  opts: { limit: number; offset: number; includeDrafts: boolean },
): Promise<PublicEvent[]> {
  const visible = opts.includeDrafts ? sql`true` : inArray(events.status, ["published", "cancelled", "past"]);
  const rows = await db.select().from(events).where(visible).orderBy(desc(events.startsAt)).limit(opts.limit).offset(opts.offset);
  return withGoing(db, rows);
}

export async function sitemapEvents(db: Db): Promise<{ key: string; status: "published"; updatedAt: string | null }[]> {
  const rows = await db.select().from(events).where(eq(events.status, "published")).orderBy(asc(events.startsAt));
  return rows.map((r) => ({ key: r.eventKey, status: "published" as const, updatedAt: r.updatedAt.toISOString() }));
}

/** Feed scope: upcoming (ends_at >= now), soonest first. `statuses` differs for RSS vs ICS. */
export async function listFeed(db: Db, statuses: ("published" | "cancelled")[], now = new Date()) {
  return db
    .select()
    .from(events)
    .where(and(inArray(events.status, statuses), gte(events.endsAt, now)))
    .orderBy(asc(events.startsAt));
}

export async function getEventRow(db: Db, key: string) {
  const [row] = await db.select().from(events).where(eq(events.eventKey, key));
  return row ?? null;
}
