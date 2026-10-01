// Public event reads (W8). Published-only unless the caller is a moderator.
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index";
import { events, rsvps } from "../db/admin-schema";
import { users } from "../db/schema";
import { EVENTS_PAST_DRAWER_LIMIT, escapeLikeTerm, PAST_EVENTS_PAGE_SIZE } from "../islands/contracts";

export type PublicEvent = typeof events.$inferSelect & { goingCount: number };

export type HomeEvent = Pick<PublicEvent, "eventKey" | "title" | "startsAt" | "timezone" | "location" | "goingCount">;

export const PAGE_SIZE = PAST_EVENTS_PAGE_SIZE;
export const JSON_DEFAULT_LIMIT = PAST_EVENTS_PAGE_SIZE;
export const JSON_MAX_LIMIT = 100;

async function withGoing(db: Pick<Db, "select">, rows: (typeof events.$inferSelect)[]): Promise<PublicEvent[]> {
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

/** Upcoming = visible, finite boundaries and not yet ended, soonest first (legacy `upcoming()`). */
export async function listUpcoming(db: Db, now = new Date(), opts: CalendarReadOpts = {}): Promise<PublicEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(calendarVisible(opts), finiteEventWindow, gte(events.endsAt, now)))
    .orderBy(asc(events.startsAt));
  return withGoing(db, rows);
}

// Exclude PostgreSQL infinity starts before limits so unusable links cannot occupy slots.
const finiteEventStart = sql`isfinite(${events.startsAt})`;

// Rendered boundaries decode PostgreSQL infinity to invalid Dates whose
// `toISOString()`/formatting throws, so upcoming reads refuse either one.
const finiteEventWindow = and(sql`isfinite(${events.startsAt})`, sql`isfinite(${events.endsAt})`);

export const HOME_EVENTS_DEADLINE_MS = 1000;
// Each of the two reads is cancelled server-side before the response deadline.
export const HOME_EVENTS_DB_TIMEOUT_MS = 400;

/** Home teaser: published and not ended, capped in SQL; calendar visibility is broader. */
export async function listHomeUpcoming(db: Db, now = new Date()): Promise<HomeEvent[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('lock_timeout', ${`${HOME_EVENTS_DB_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${HOME_EVENTS_DB_TIMEOUT_MS}ms`}, true)`,
    );
    const rows = await tx
      .select()
      .from(events)
      .where(and(eq(events.status, "published"), gte(events.endsAt, now), finiteEventStart))
      .orderBy(asc(events.startsAt), asc(events.id))
      .limit(3);
    // The homepage gets public signposts and an aggregate, never creator or RSVP identities.
    return (await withGoing(tx, rows)).map(({ eventKey, title, startsAt, timezone, location, goingCount }) =>
      ({ eventKey, title, startsAt, timezone, location, goingCount }));
  });
}

/** Bound connection setup as well as both optional reads; never log driver messages/SQL/identities. */
export async function loadHomeUpcoming(openDb: () => Promise<Db | null>): Promise<HomeEvent[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = Promise.resolve().then(openDb).then((db) => db ? listHomeUpcoming(db) : null);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("HomeEventsDeadline")), HOME_EVENTS_DEADLINE_MS);
  });
  try {
    return await Promise.race([read, deadline]);
  } catch (err) {
    console.warn("Home events unavailable; serving the fallback.", {
      exception: err instanceof Error && err.message === "HomeEventsDeadline" ? "HomeEventsDeadline" : "ReadFailure",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
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

/** Invalid HTML archive pages/offsets retain the page-one fallback. */
export function normalizePastPage(page: number): number {
  return Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger((page - 1) * PAGE_SIZE) ? page : 1;
}

/** Past archive: ended (published-then-closed or already `past`), newest first, 20/page. */
export async function listPast(db: Db, page: number, now = new Date(), q: string | null = null): Promise<{ rows: PublicEvent[]; hasMore: boolean; totalPages: number }> {
  page = normalizePastPage(page);
  const archived = and(or(eq(events.status, "past"), and(eq(events.status, "published"), lt(events.endsAt, now))), searchCondition(q));
  const [total] = await db.select({ n: count() }).from(events).where(archived);
  const totalPages = Math.ceil(Number(total?.n ?? 0) / PAGE_SIZE);
  if (page > totalPages) return { rows: [], hasMore: false, totalPages };
  const rows = await db
    .select()
    .from(events)
    .where(archived)
    .orderBy(desc(events.startsAt), desc(events.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE);
  return {
    rows: await withGoing(db, rows.slice(0, PAGE_SIZE)),
    hasMore: rows.length > PAGE_SIZE,
    totalPages,
  };
}

export async function withGoingCount(db: Db, row: typeof events.$inferSelect): Promise<PublicEvent> {
  return (await withGoing(db, [row]))[0]!;
}

export async function getPublicEvent(db: Db, key: string): Promise<PublicEvent | null> {
  const [row] = await db.select().from(events).where(eq(events.eventKey, key));
  if (!row) return null;
  return withGoingCount(db, row);
}

export type EventLink = Pick<PublicEvent, "id" | "eventKey" | "title" | "startsAt" | "timezone" | "location">;
export interface EventNeighbors {
  previous: EventLink | null;
  next: EventLink | null;
}

const eventLinkColumns = {
  id: events.id,
  eventKey: events.eventKey,
  title: events.title,
  startsAt: events.startsAt,
  timezone: events.timezone,
  location: events.location,
};

/** Published links only, even for moderators. Equal starts use id as the legacy tiebreak. */
export async function getEventNeighbors(db: Db, event: Pick<PublicEvent, "id">): Promise<EventNeighbors> {
  // Compare the stored timestamp: a JS Date loses PostgreSQL's microseconds.
  const anchorStartsAt = db.select({ startsAt: events.startsAt }).from(events).where(eq(events.id, event.id));
  const [previous, next] = await Promise.all([
    db.select(eventLinkColumns).from(events)
      .where(and(eq(events.status, "published"), ne(events.id, event.id), finiteEventStart, or(
        lt(events.startsAt, anchorStartsAt),
        and(eq(events.startsAt, anchorStartsAt), lt(events.id, event.id)),
      )))
      .orderBy(desc(events.startsAt), desc(events.id)).limit(1),
    db.select(eventLinkColumns).from(events)
      .where(and(eq(events.status, "published"), ne(events.id, event.id), finiteEventStart, or(
        gt(events.startsAt, anchorStartsAt),
        and(eq(events.startsAt, anchorStartsAt), gt(events.id, event.id)),
      )))
      .orderBy(asc(events.startsAt), asc(events.id)).limit(1),
  ]);
  return { previous: previous[0] ?? null, next: next[0] ?? null };
}

/** Same game first, then nearest upcoming siblings; one query, no RSVP aggregates. */
export async function listRelatedEvents(
  db: Db,
  event: Pick<PublicEvent, "id" | "game">,
  now = new Date(),
): Promise<EventLink[]> {
  const sameGame = event.game === null ? [] : [sql`case when ${events.game} = ${event.game} then 0 else 1 end`];
  const rows = await db.select(eventLinkColumns).from(events)
    .where(and(eq(events.status, "published"), ne(events.id, event.id), finiteEventStart, gte(events.endsAt, now)))
    .orderBy(...sameGame, asc(events.startsAt), asc(events.id))
    .limit(3);
  // PostgreSQL infinity timestamps decode to invalid Dates, as in 404 suggestions.
  return rows.filter((event) => Number.isFinite(event.startsAt.getTime()));
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
  opts: { limit: number; offset: number; includeDrafts: boolean; eventKey?: string },
): Promise<{ rows: PublicEvent[]; total: number }> {
  const visible = opts.includeDrafts ? sql`true` : inArray(events.status, ["published", "cancelled", "past"]);
  const match = opts.eventKey === undefined ? undefined : eq(events.eventKey, opts.eventKey);
  const predicate = and(visible, match);
  const [total] = await db.select({ n: count() }).from(events).where(predicate);
  const rows = await db.select().from(events).where(predicate).orderBy(asc(events.startsAt), asc(events.id)).limit(opts.limit).offset(opts.offset);
  return { rows: await withGoing(db, rows), total: Number(total?.n ?? 0) };
}

export async function sitemapEvents(db: Db): Promise<{ key: string; status: "published"; updatedAt: string | null }[]> {
  const rows = await db.select().from(events).where(eq(events.status, "published")).orderBy(asc(events.startsAt));
  return rows.map((r) => ({ key: r.eventKey, status: "published" as const, updatedAt: r.updatedAt.toISOString() }));
}

/** Feed scope: upcoming, finite boundaries, ends_at >= now, soonest first. `statuses` differs for RSS vs ICS. */
export async function listFeed(db: Db, statuses: ("published" | "cancelled")[], now = new Date()) {
  return db
    .select()
    .from(events)
    .where(and(inArray(events.status, statuses), finiteEventWindow, gte(events.endsAt, now)))
    .orderBy(asc(events.startsAt));
}

export async function getEventRow(db: Db, key: string) {
  const [row] = await db.select().from(events).where(eq(events.eventKey, key));
  return row ?? null;
}
