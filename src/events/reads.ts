// Public event reads (W8).
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db } from "../db/index";
import { PUBLIC_DATA_BOUNDS, PUBLIC_EVENT_STATUS } from "../public-data/contracts";
import { events, rsvps } from "../db/admin-schema";
import { users } from "../db/schema";
import { keyedMemberRead, nonSensitiveRead } from "../member-reads";
import { safeRequestId } from "../request-log";
import {
  calendarGridRange,
  dedupeTransients,
  EVENTS_MONTH_GRID_LIMIT,
  EVENTS_PAST_DRAWER_LIMIT,
  EVENTS_UPCOMING_PAGE_SIZE,
  escapeLikeTerm,
  PAST_EVENTS_PAGE_SIZE,
  type DiscordTransient,
} from "../islands/contracts";
import { calendarZone, wallDateIso, wallDayStart } from "./date-format";
import type { DiscordEventsSource } from "./discord-transients-types";

export type PublicEvent = typeof events.$inferSelect & {
  goingCount: number;
  /** Seat occupancy: every going row, like `waitlist.goingCount`. Drives the
   * `full` verdict, spots-left text and Going/waitlist CTA so the page never
   * offers a seat the write path cannot grant. Required (not optional) so a
   * new code path that forgets to wire it fails typecheck instead of
   * silently regressing to the named count; `withGoing` always sets it. */
  goingOccupancy: number;
};

export type HomeEvent = Pick<
  PublicEvent,
  "eventKey" | "title" | "startsAt" | "timezone" | "location" | "goingCount"
>;

export const PAGE_SIZE = PAST_EVENTS_PAGE_SIZE;
export const JSON_DEFAULT_LIMIT = PUBLIC_DATA_BOUNDS.defaultPageSize;
export const JSON_MAX_LIMIT = PUBLIC_DATA_BOUNDS.maxPageSize;

/** Two going counts per event, so the badge and the seats agree with the
 * roster and the write path at once.
 * `listGoingAttendees` excludes nameless rows (empty stored name, or no user
 * row at all) so no nameless identity is ever rendered. `goingCount` joins
 * users and counts only named rows, so it always equals the roster length
 * (within one roster page) and drives the visible "N going" label.
 * `goingOccupancy` counts every going row — the same shape as
 * `waitlist.goingCount`, the write-path seat enforcement — and drives the
 * `full` verdict, the spots-left text and the Going/waitlist CTA in
 * `rsvp-button.tsx` (plus the Kit mirror), so the page never offers a seat
 * the write cannot grant. Both are aggregates only; neither renders a name. */
async function withGoing(
  db: Pick<Db, "select">,
  rows: (typeof events.$inferSelect)[],
): Promise<PublicEvent[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [named, occupied] = await Promise.all([
    nonSensitiveRead("going-counts", () =>
      db
        .select({ eventId: rsvps.eventId, n: count() })
        .from(rsvps)
        .innerJoin(users, eq(rsvps.userId, users.id))
        .where(and(inArray(rsvps.eventId, ids), eq(rsvps.status, "going"), ne(users.username, "")))
        .groupBy(rsvps.eventId),
    ),
    nonSensitiveRead("going-counts", () =>
      db
        .select({ eventId: rsvps.eventId, n: count() })
        .from(rsvps)
        .where(and(inArray(rsvps.eventId, ids), eq(rsvps.status, "going")))
        .groupBy(rsvps.eventId),
    ),
  ]);
  const byNamed = new Map(named.map((c) => [c.eventId, Number(c.n)]));
  const byOccupied = new Map(occupied.map((c) => [c.eventId, Number(c.n)]));
  return rows.map((r) => ({
    ...r,
    goingCount: byNamed.get(r.id) ?? 0,
    goingOccupancy: byOccupied.get(r.id) ?? 0,
  }));
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

/** Invalid list-page numbers retain the page-one fallback, like the archive —
 * including overflow, where the offset would stop being a safe integer. */
export function normalizeUpcomingPage(page: number): number {
  return Number.isSafeInteger(page) &&
    page > 0 &&
    Number.isSafeInteger((page - 1) * EVENTS_UPCOMING_PAGE_SIZE)
    ? page
    : 1;
}

/** Upcoming = visible, finite boundaries and not yet ended, soonest first (legacy `upcoming()`). Equal starts break ties by id for a deterministic total order. Paged like the past archive: one page of full rows, so the read, the RSVP aggregate and the rendered HTML stay bounded no matter how many future events exist. A page past the end renders empty (with an out-of-range note) instead of clamping, exactly like `listPast`. */
export async function listUpcoming(
  db: Db,
  now = new Date(),
  opts: CalendarReadOpts = {},
  page = 1,
): Promise<{ rows: PublicEvent[]; hasMore: boolean; totalPages: number; total: number }> {
  page = normalizeUpcomingPage(page);
  const visible = and(calendarVisible(opts), finiteEventWindow, gte(events.endsAt, now));
  const [total] = await db.select({ n: count() }).from(events).where(visible);
  const n = Number(total?.n ?? 0);
  const totalPages = Math.ceil(n / EVENTS_UPCOMING_PAGE_SIZE);
  // Like `listPast`: a page past the end costs only the count, never a skipped scan.
  if (page > totalPages) return { rows: [], hasMore: false, totalPages, total: n };
  const rows = await db
    .select()
    .from(events)
    .where(visible)
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(EVENTS_UPCOMING_PAGE_SIZE + 1)
    .offset((page - 1) * EVENTS_UPCOMING_PAGE_SIZE);
  // Like `listPast`, the total still counts unrenderable windows so page
  // boundaries stay stable while poison rows drop out of the render.
  return {
    rows: await withGoing(
      db,
      rows.slice(0, EVENTS_UPCOMING_PAGE_SIZE).filter(isRenderableEventWindow),
    ),
    hasMore: rows.length > EVENTS_UPCOMING_PAGE_SIZE,
    totalPages,
    total: n,
  };
}

/** Zero-based rank of one visible event in the upcoming order: the count of
 * visible rows sorted before it. Null when the key is absent, invisible,
 * ended or unrenderable — a grid day-jump to it keeps the requested page.
 * Two small reads, only for explicit `event` jumps, never for a plain render. */
export async function rankUpcoming(
  db: Db,
  key: string,
  now = new Date(),
  opts: CalendarReadOpts = {},
): Promise<number | null> {
  const [anchor] = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.eventKey, key),
        calendarVisible(opts),
        finiteEventWindow,
        gte(events.endsAt, now),
      ),
    );
  if (!anchor || !isRenderableEventWindow(anchor)) return null;
  // Compare the stored timestamp: a JS Date loses PostgreSQL's microseconds.
  const anchorStartsAt = db
    .select({ startsAt: events.startsAt })
    .from(events)
    .where(eq(events.id, anchor.id));
  const [before] = await db
    .select({ n: count() })
    .from(events)
    .where(
      and(
        calendarVisible(opts),
        finiteEventWindow,
        gte(events.endsAt, now),
        or(
          lt(events.startsAt, anchorStartsAt),
          and(eq(events.startsAt, anchorStartsAt), lt(events.id, anchor.id)),
        ),
      ),
    );
  return Number(before?.n ?? 0);
}

/** Month-grid scope: the visible upcoming rows plotted on the grid for `month`
 * ("YYYY-MM", caller-validated). The grid renders whole Monday-first weeks,
 * so the covered range reaches into the adjacent months and the read keeps
 * exactly the rows landing on a covered wall day in their own zone. SQL reads
 * the covered UTC days widened for the widest zone offset; the grid cap is a
 * pathological guard only: a real month never holds that many events. */
export async function listUpcomingForMonth(
  db: Db,
  month: string,
  now = new Date(),
  opts: CalendarReadOpts = {},
): Promise<PublicEvent[]> {
  // A bad month is an empty grid, never a 500: the route only passes
  // validated months, this keeps the read total.
  const range = calendarGridRange(month);
  if (!range) return [];
  const from = new Date(wallDayStart(range.first) - 86400000);
  const to = new Date(wallDayStart(range.last) + 2 * 86400000);
  const firstDay = wallDayStart(range.first);
  const lastDay = wallDayStart(range.last);
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        calendarVisible(opts),
        finiteEventWindow,
        gte(events.endsAt, now),
        gte(events.startsAt, from),
        lt(events.startsAt, to),
      ),
    )
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(EVENTS_MONTH_GRID_LIMIT);
  return withGoing(
    db,
    rows.filter((r) => {
      if (!isRenderableEventWindow(r)) return false;
      const day = wallDayStart(wallDateIso(r.startsAt, r.timezone));
      return day >= firstDay && day <= lastDay;
    }),
  );
}

// Exclude PostgreSQL infinity starts before limits so unusable links cannot occupy slots.
const finiteEventStart = sql`isfinite(${events.startsAt})`;

// Rendered boundaries decode PostgreSQL infinity to invalid Dates whose
// `toISOString()`/formatting throws, so upcoming reads refuse either one.
const finiteEventWindow = and(sql`isfinite(${events.startsAt})`, sql`isfinite(${events.endsAt})`);

export const HOME_EVENTS_DEADLINE_MS = 1000;
// Each of the two reads is cancelled server-side before the response deadline.
export const HOME_EVENTS_DB_TIMEOUT_MS = 400;
// The Discord snapshot read gets its own bound below the homepage deadline.
// A stale-snapshot refresh claimant runs a claim transaction plus a live
// Discord GET, so it can outlast the homepage race on its own; without this
// bound that one request would hide the canonical rows behind the
// unavailable state. On timeout the Discord rows degrade to none with
// discordFailed set, never to a whole-read failure.
export const HOME_DISCORD_TIMEOUT_MS = 700;

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
    // The teaser renders `startsAt` unguarded, so unrenderable windows are
    // refused here too (this read never had #232's `isfinite()` guard).
    return (await withGoing(tx, rows.filter(isRenderableEventWindow))).map(
      ({ eventKey, title, startsAt, timezone, location, goingCount }) => ({
        eventKey,
        title,
        startsAt,
        timezone,
        location,
        goingCount,
      }),
    );
  });
}

/**
 * Homepage teaser row: canonical published events plus display-only Discord
 * snapshot rows, labelled by source. Discord rows carry no RSVP aggregate and
 * no detail page — they keep their Discord invite link at render time.
 * Never carries creator, RSVP identities, or member data.
 */
export type HomeCanonicalRow = HomeEvent & { source: "canonical" };
export type HomeDiscordRow = {
  source: "discord";
  discordId: string;
  title: string;
  startsAt: Date;
  /** Effective display zone (modal zone over canonical upcoming plus recent past rows, like /events; UTC only when both are empty). */
  timezone: string;
  location: string | null;
};
export type HomeUpcomingRow = HomeCanonicalRow | HomeDiscordRow;

/** Homepage teaser cap: the soonest rows across both sources, like the SQL cap. */
export const HOME_UPCOMING_LIMIT = 3;

/**
 * Pure merge for the homepage teaser (shared with the SvelteKit card): the
 * same source-aware rules as /events — deduplicated Discord transients,
 * hidden-event suppression via persisted ids, re-checked against the local
 * clock — merged in start order and capped. No private data enters or leaves.
 */
export function mergeHomeUpcoming(
  canonical: HomeEvent[],
  transients: DiscordTransient[],
  persistedDiscordIds: ReadonlySet<string>,
  now: Date,
  fallbackZone?: string,
): HomeUpcomingRow[] {
  const zone = fallbackZone ?? calendarZone(canonical.map((e) => e.timezone));
  const eligible = dedupeTransients(transients, persistedDiscordIds).filter(
    (t) =>
      Number.isFinite(t.startsAt.getTime()) &&
      (t.endsAt === null || (Number.isFinite(t.endsAt.getTime()) && t.endsAt >= now)),
  );
  const rows: HomeUpcomingRow[] = [
    ...canonical.map((e): HomeUpcomingRow => ({ ...e, source: "canonical" as const })),
    ...eligible.map(
      (t): HomeUpcomingRow => ({
        source: "discord" as const,
        discordId: t.discordId,
        title: t.title,
        startsAt: t.startsAt,
        timezone: zone,
        location: t.location,
      }),
    ),
  ];
  // Same start-order rule as /events' mergeCalendarRows; stable so canonical
  // keeps its SQL order on equal starts.
  return rows
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, HOME_UPCOMING_LIMIT);
}

/**
 * Recent past timezones for the homepage display zone, mirroring /events'
 * past drawer (`loadCalendarPageModel` derives its zone from upcoming page
 * rows plus `listCalendarPast`). Lightweight: one timezone-only select, no
 * RSVP aggregate — the zone is public data and the teaser never renders
 * these rows. The caller treats a failure as no past zones, falling back to
 * the canonical-only zone (UTC when that is empty too).
 */
export async function listHomePastTimezones(db: Db, now = new Date()): Promise<string[]> {
  const rows = await db
    .select({ timezone: events.timezone })
    .from(events)
    .where(and(ne(events.status, "draft"), lt(events.endsAt, now)))
    .orderBy(desc(events.startsAt), desc(events.id))
    .limit(EVENTS_PAST_DRAWER_LIMIT);
  return rows.map((r) => r.timezone);
}

export interface HomeUpcomingMerged {
  items: HomeUpcomingRow[];
  /** True when neither source could produce a trustworthy list (DB down, or empty + Discord failed). */
  unavailable: boolean;
  discordFailed: boolean;
}

/** Bounded exception class plus the validated request_id, so a fallback line joins to its request log; never driver text, SQL or identities. */
function warnHomeFallback(err: unknown, requestId?: string): void {
  console.warn("Home events unavailable; serving the fallback.", {
    request_id: safeRequestId(requestId),
    exception:
      err instanceof Error && err.message === "HomeEventsDeadline"
        ? "HomeEventsDeadline"
        : "ReadFailure",
  });
}

/**
 * Source-aware homepage read: canonical teaser rows plus eligible Discord
 * snapshot transients, deduplicated with hidden-event suppression. Reuses the
 * existing cache/freshness/outage contracts — never throws, never a 500.
 * An empty canonical list with a failed Discord read is the unavailable state
 * (like /events' error state), never "nothing scheduled".
 */
export async function loadHomeUpcomingMerged(
  openDb: () => Promise<Db | null>,
  getDiscordSource: () => DiscordEventsSource,
  now = new Date(),
  requestId?: string,
): Promise<HomeUpcomingMerged> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read: Promise<HomeUpcomingMerged> = (async () => {
    const db = await openDb();
    if (!db) return { items: [], unavailable: true, discordFailed: false };
    const discord = getDiscordSource();
    // Canonical, past-zone and Discord reads start together: a slow Discord
    // refresh must never hold the canonical rows past the deadline.
    const canonicalPromise = listHomeUpcoming(db, now);
    const pastZonesPromise = listHomePastTimezones(db, now).catch(() => [] as string[]);
    let discordTimer: ReturnType<typeof setTimeout> | undefined;
    const discordTimeout = new Promise<null>((resolve) => {
      discordTimer = setTimeout(() => resolve(null), HOME_DISCORD_TIMEOUT_MS);
    });
    const discordPromise = Promise.race([
      discord.upcoming(now).catch(() => [] as DiscordTransient[]),
      discordTimeout,
    ]).finally(() => clearTimeout(discordTimer));
    const [canonical, pastZones, discordRowsOrNull] = await Promise.all([
      canonicalPromise,
      pastZonesPromise,
      discordPromise,
    ]);
    const discordTimedOut = discordRowsOrNull === null;
    const discordRows = discordTimedOut ? [] : (discordRowsOrNull as DiscordTransient[]);
    // A timed-out Discord read counts as failed (its rows are unknown), so
    // an empty canonical list still reports unavailable rather than "empty".
    const discordFailed = discordTimedOut || discord.lastReadFailed();
    const persisted = await persistedDiscordIds(
      db,
      discordRows.map((t) => t.discordId),
    );
    // Same zone rule as /events: modal zone over upcoming rows plus recent
    // past rows, so a Discord-only teaser matches the /events wall time.
    const zone = calendarZone([...canonical.map((e) => e.timezone), ...pastZones]);
    const items = mergeHomeUpcoming(canonical, discordRows, persisted, now, zone);
    if (items.length === 0 && discordFailed) return { items, unavailable: true, discordFailed };
    return { items, unavailable: false, discordFailed };
  })();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("HomeEventsDeadline")), HOME_EVENTS_DEADLINE_MS);
  });
  try {
    return await Promise.race([read, deadline]);
  } catch (err) {
    warnHomeFallback(err, requestId);
    return { items: [], unavailable: true, discordFailed: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Bound connection setup as well as both optional reads; never log driver messages/SQL/identities. */
export async function loadHomeUpcoming(
  openDb: () => Promise<Db | null>,
  requestId?: string,
): Promise<HomeEvent[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = Promise.resolve()
    .then(openDb)
    .then((db) => (db ? listHomeUpcoming(db) : null));
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("HomeEventsDeadline")), HOME_EVENTS_DEADLINE_MS);
  });
  try {
    return await Promise.race([read, deadline]);
  } catch (err) {
    warnHomeFallback(err, requestId);
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
  // Ended rows are normally renderable by construction (ends_at < now), but
  // imports can violate the end-after-start invariant with an unrenderable
  // starts_at, and the drawer/`EmptyGap` render it unguarded.
  return withGoing(db, rows.filter(isRenderableEventWindow));
}

/** Invalid HTML archive pages/offsets retain the page-one fallback. */
export function normalizePastPage(page: number): number {
  return Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger((page - 1) * PAGE_SIZE)
    ? page
    : 1;
}

/** Past archive: ended (published-then-closed or already `past`), newest first, 20/page. */
export async function listPast(
  db: Db,
  page: number,
  now = new Date(),
  q: string | null = null,
): Promise<{ rows: PublicEvent[]; hasMore: boolean; totalPages: number }> {
  page = normalizePastPage(page);
  const archived = and(
    or(eq(events.status, "past"), and(eq(events.status, "published"), lt(events.endsAt, now))),
    searchCondition(q),
  );
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
  // Same refusal as the other served reads: the archive `Card` renders
  // `startsAt` unguarded, and imports can carry an unrenderable starts_at on
  // an otherwise-ended (hence archived) row.
  return {
    rows: await withGoing(db, rows.slice(0, PAGE_SIZE).filter(isRenderableEventWindow)),
    hasMore: rows.length > PAGE_SIZE,
    totalPages,
  };
}

export async function withGoingCount(
  db: Db,
  row: typeof events.$inferSelect,
): Promise<PublicEvent> {
  return (await withGoing(db, [row]))[0]!;
}

export async function getPublicEvent(db: Db, key: string): Promise<PublicEvent | null> {
  const [row] = await nonSensitiveRead("events", () =>
    db.select().from(events).where(eq(events.eventKey, key)),
  );
  // A stored window no Date can represent cannot render (same RangeError as
  // the upcoming path), so the page 404s with suggestions instead of 500ing.
  if (!row || !isRenderableEventWindow(row)) return null;
  return withGoingCount(db, row);
}

export type EventLink = Pick<
  PublicEvent,
  "id" | "eventKey" | "title" | "startsAt" | "timezone" | "location"
>;
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

/**
 * PostgreSQL accepts finite timestamps far outside the JS Date range (up to
 * year 294276); the driver decodes those to invalid Dates whose
 * `getTime()` is NaN and whose `toISOString()`/formatting throws RangeError
 * (TOG-11700). `isfinite()` cannot see them, so served reads refuse them in
 * JS the same way 404 suggestions and related links already do. The write
 * path caps years at four digits, so only imports can carry such rows.
 */
export function isRenderableEventWindow(
  row: Pick<typeof events.$inferSelect, "startsAt" | "endsAt">,
): boolean {
  return Number.isFinite(row.startsAt.getTime()) && Number.isFinite(row.endsAt.getTime());
}

/** Published, not-ended links only, even for moderators. Equal starts use id as the legacy tiebreak. */
export async function getEventNeighbors(
  db: Db,
  event: Pick<PublicEvent, "id">,
  now = new Date(),
): Promise<EventNeighbors> {
  // Compare the stored timestamp: a JS Date loses PostgreSQL's microseconds.
  const anchorStartsAt = db
    .select({ startsAt: events.startsAt })
    .from(events)
    .where(eq(events.id, event.id));
  const [previous, next] = await Promise.all([
    nonSensitiveRead("events", () =>
      db
        .select(eventLinkColumns)
        .from(events)
        .where(
          and(
            eq(events.status, "published"),
            ne(events.id, event.id),
            finiteEventStart,
            gte(events.endsAt, now),
            or(
              lt(events.startsAt, anchorStartsAt),
              and(eq(events.startsAt, anchorStartsAt), lt(events.id, event.id)),
            ),
          ),
        )
        .orderBy(desc(events.startsAt), desc(events.id))
        .limit(1),
    ),
    nonSensitiveRead("events", () =>
      db
        .select(eventLinkColumns)
        .from(events)
        .where(
          and(
            eq(events.status, "published"),
            ne(events.id, event.id),
            finiteEventStart,
            gte(events.endsAt, now),
            or(
              gt(events.startsAt, anchorStartsAt),
              and(eq(events.startsAt, anchorStartsAt), gt(events.id, event.id)),
            ),
          ),
        )
        .orderBy(asc(events.startsAt), asc(events.id))
        .limit(1),
    ),
  ]);
  return { previous: previous[0] ?? null, next: next[0] ?? null };
}

/** Same game first, then nearest upcoming siblings; one query, no RSVP aggregates. */
export async function listRelatedEvents(
  db: Db,
  event: Pick<PublicEvent, "id" | "game">,
  now = new Date(),
): Promise<EventLink[]> {
  const sameGame =
    event.game === null ? [] : [sql`case when ${events.game} = ${event.game} then 0 else 1 end`];
  const rows = await nonSensitiveRead("events", () =>
    db
      .select(eventLinkColumns)
      .from(events)
      .where(
        and(
          eq(events.status, "published"),
          ne(events.id, event.id),
          finiteEventStart,
          gte(events.endsAt, now),
        ),
      )
      .orderBy(...sameGame, asc(events.startsAt), asc(events.id))
      .limit(3),
  );
  // PostgreSQL infinity timestamps decode to invalid Dates, as in 404 suggestions.
  return rows.filter((event) => Number.isFinite(event.startsAt.getTime()));
}

/** Viewer answer for the RSVP island (TOG-9839 slice 2): the caller's own row
 * only — keyed on the session user, never another member's. Null when the
 * viewer has not answered. Waitlist copy uses the null-position fallback:
 * there is no position column and no waitlist-count query. */
export type ViewerRsvp = { status: string; syncedToDiscordAt: Date | null };
export async function getViewerRsvp(
  db: Db,
  eventId: number,
  userId: string,
): Promise<ViewerRsvp | null> {
  // Keyed like every other member projection: inside main's keyed-read
  // boundary (#145) the observer consumes the single permitted query and
  // attributes the caller's own user_id before the response is released.
  // The where-clause pins the row to the session user, so a populated
  // viewers' list contains exactly the caller and the boundary's subject
  // accounting matches the caller's own key.
  const [row] = await keyedMemberRead(() =>
    db
      .select({
        userId: rsvps.userId,
        status: rsvps.status,
        syncedToDiscordAt: rsvps.syncedToDiscordAt,
      })
      .from(rsvps)
      .where(and(eq(rsvps.eventId, eventId), eq(rsvps.userId, userId))),
  );
  return row ? { status: row.status, syncedToDiscordAt: row.syncedToDiscordAt } : null;
}

export type EventAttendee = { id: string; name: string };

/** Member attendee paging: one page of named going identities, oldest answers
 * first. The legacy answer-time order is kept (not the admin roster's
 * most-recent-update order); the 100-row size reuses the admin roster
 * convention (ROSTER_PAGE_SIZE). */
export const ATTENDEE_PAGE_SIZE = 100;

/** Defensive page form, mirroring normalizePastPage: invalid numbers retain
 * the page-one fallback, including overflow where the offset would stop being
 * a safe integer. */
export function normalizeAttendeePage(page: number): number {
  return Number.isSafeInteger(page) &&
    page > 0 &&
    Number.isSafeInteger((page - 1) * ATTENDEE_PAGE_SIZE)
    ? page
    : 1;
}

/** Strict ?attendees= validation, mirroring the admin table viewers: the raw
 * value must be a positive integer in full (parseInt would accept "2x" as 2),
 * and its OFFSET arithmetic must stay exact. Missing, malformed, nonpositive,
 * fractional, padded or unsafe values all fall back to page 1. */
export function parseAttendeePageParam(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || !/^[1-9]\d*$/.test(raw)) return 1;
  return normalizeAttendeePage(Number(raw));
}

/** Native attendee page URL: page 1 stays bare so first-page links reset the
 * section, like the roster's page-one convention. */
export function attendeePageHref(eventKey: string, page: number): string {
  return page <= 1 ? `/e/${eventKey}` : `/e/${eventKey}?attendees=${page}`;
}

/** Encoded variant for POST destinations built from the routed :key param:
 * the key is encoded (route input) while the page stays a validated integer,
 * so malformed/unsafe page values can never escape the local destination. */
export function rsvpPageReturnPath(eventKey: string, page: number): string {
  const base = `/e/${encodeURIComponent(eventKey)}`;
  return page > 1 ? `${base}?attendees=${page}` : base;
}

/** Strict native-RSVP page resolution across the submitted carriers (action
 * query values plus the body attendees value). Missing carriers are absent;
 * any present but malformed value (duplicates, non-strings, padded/suffixed
 * numbers, unsafe integers, URLs, cross-event paths) normalizes to page 1,
 * and disagreeing carriers fall back to page 1 — so tampering can never
 * choose an external destination or select an offset. Valid agreement keeps
 * the page; page 1 stays bare. Referer is never a carrier. */
export function resolveNativeRsvpPage(
  queryValues: readonly string[],
  bodyValue: unknown,
  hasBody: boolean,
): number {
  const normalizePresent = (raw: unknown): number =>
    typeof raw === "string" ? parseAttendeePageParam(raw) : 1;
  let queryPage: number | null = null;
  if (queryValues.length > 0) {
    queryPage = queryValues.length > 1 ? 1 : normalizePresent(queryValues[0]);
  }
  let bodyPage: number | null = null;
  if (hasBody) {
    if (Array.isArray(bodyValue)) {
      bodyPage = bodyValue.length === 1 ? normalizePresent(bodyValue[0]) : 1;
    } else {
      bodyPage = normalizePresent(bodyValue);
    }
  }
  if (queryPage !== null && bodyPage !== null) {
    return queryPage === bodyPage ? queryPage : 1;
  }
  return queryPage ?? bodyPage ?? 1;
}

/** Next-page probe for the one-row lookahead: the probe's own OFFSET must stay
 * exact too, so at the safe-integer ceiling it re-probes the current page
 * (empty up there, hence no false Next) instead of falling back to page 1. */
export function nextAttendeePage(page: number): number {
  return Number.isSafeInteger(page * ATTENDEE_PAGE_SIZE) ? page + 1 : page;
}

/** Member-only projection, never part of PublicEvent or the feeds/JSON. One
 * bounded retrieval at SQL (limit/offset, never fetch-all-then-slice): `limit`
 * bounds the page itself (100) as well as the one-row lookahead probe that
 * powers Next. Every retrieved row — lookahead included — is audit-observed
 * before release, so an unbounded read shows up as extra audit subjects even
 * when the render hides them. */
export async function listGoingAttendees(
  db: Db,
  eventId: number,
  page = 1,
  limit = ATTENDEE_PAGE_SIZE,
): Promise<EventAttendee[]> {
  page = normalizeAttendeePage(page);
  const bounded =
    Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, ATTENDEE_PAGE_SIZE)
      : ATTENDEE_PAGE_SIZE;
  // Legacy answer-time order, not the admin roster's most-recent-update order.
  // Partial select/join/orderBy: https://orm.drizzle.team/docs/select
  // Exclude nameless rows in SQL: every retrieved identity is attributable.
  return keyedMemberRead(() =>
    db
      .select({ id: users.id, name: users.username })
      .from(rsvps)
      .innerJoin(users, eq(rsvps.userId, users.id))
      .where(and(eq(rsvps.eventId, eventId), eq(rsvps.status, "going"), ne(users.username, "")))
      .orderBy(asc(rsvps.createdAt), asc(rsvps.id))
      .limit(bounded)
      .offset((page - 1) * ATTENDEE_PAGE_SIZE),
  );
}

/** Public JSON collection: only published rows are counted or paginated. */
export async function listJson(
  db: Db,
  opts: { limit: number; offset: number; eventKey?: string },
): Promise<{ rows: PublicEvent[]; total: number; page: number }> {
  const match = opts.eventKey === undefined ? undefined : eq(events.eventKey, opts.eventKey);
  const predicate = and(eq(events.status, PUBLIC_EVENT_STATUS), match);
  const [total] = await db.select({ n: count() }).from(events).where(predicate);
  const n = Number(total?.n ?? 0);
  // Bound the scan before issuing it: a page past the end clamps to the last
  // page, so OFFSET stays inside the collection instead of skipping past every
  // row (a ~1e10 OFFSET is a full-table scan that slows/times out). The
  // division also absorbs an unaligned or non-finite requested offset back to
  // a page whose recomputed offset is always issued.
  const lastPage = Math.max(1, Math.ceil(n / opts.limit));
  const page = Math.min(Math.max(1, Math.floor(opts.offset / opts.limit) + 1), lastPage);
  const rows = await db
    .select()
    .from(events)
    .where(predicate)
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(opts.limit)
    .offset((page - 1) * opts.limit);
  // `eventJson` serializes both boundaries unguarded (`toISOString()`), so a
  // poison row would 500 the whole member collection instead of dropping out.
  // Like `listPast`, the total still counts it so page boundaries stay stable.
  return {
    rows: await withGoing(db, rows.filter(isRenderableEventWindow)),
    total: n,
    page,
  };
}

/** Egress cap for feeds and sitemap: the soonest rows in the existing order.
 * A pathological guard only — a real schedule never holds this many upcoming
 * rows. Keeps the established 103-event subscription collection whole while
 * bounding /events.ics, /events.rss, /events.md and sitemap bytes. */
export const FEED_EGRESS_LIMIT = 1000;

function warnEgressCapacity(surface: "sitemap" | "feed", returned: number): void {
  // A full bounded result is not proof that any further rows exist.
  if (returned === FEED_EGRESS_LIMIT) {
    console.warn("Event egress read reached capacity.", {
      surface,
      limit: FEED_EGRESS_LIMIT,
      returned,
    });
  }
}

export async function sitemapEvents(
  db: Db,
): Promise<{ key: string; status: "published"; updatedAt: string | null }[]> {
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.status, "published"))
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(FEED_EGRESS_LIMIT);
  warnEgressCapacity("sitemap", rows.length);
  // One poison row (unrenderable window, or an updatedAt outside the JS Date
  // range) must not empty the sitemap via the route's static fallback:
  // skip it in JS and log the count. The guard lives in JS (not SQL) because
  // SQL cannot see a timestamp that is finite in PostgreSQL but out of range
  // in JS. A DB failure still rejects here; the route degrades to the static
  // entries instead.
  const renderable = rows.filter(
    (r) =>
      isRenderableEventWindow(r) &&
      r.updatedAt instanceof Date &&
      Number.isFinite(r.updatedAt.getTime()),
  );
  const skipped = rows.length - renderable.length;
  if (skipped > 0) {
    console.warn("sitemapEvents skipped unrenderable rows.", { skipped });
  }
  return renderable.map((r) => ({
    key: r.eventKey,
    status: "published" as const,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Feed scope: upcoming, finite boundaries, ends_at >= now, soonest first. Equal starts break ties by id for a deterministic total order. `statuses` differs for RSS vs ICS. Capped in SQL at FEED_EGRESS_LIMIT. */
export async function listFeed(db: Db, statuses: ("published" | "cancelled")[], now = new Date()) {
  const rows = await db
    .select()
    .from(events)
    .where(and(inArray(events.status, statuses), finiteEventWindow, gte(events.endsAt, now)))
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(FEED_EGRESS_LIMIT);
  warnEgressCapacity("feed", rows.length);
  // Feed builders stringify date parts without throwing, so without this the
  // export would serve corrupt `NaN` instants instead of failing loudly.
  const renderable = rows.filter(isRenderableEventWindow);
  const skipped = rows.length - renderable.length;
  if (skipped > 0) {
    console.warn("listFeed skipped unrenderable rows.", { skipped });
  }
  return renderable;
}

export async function getEventRow(db: Db, key: string) {
  const [row] = await db.select().from(events).where(eq(events.eventKey, key));
  // Same refusal as the collection/single reads: a per-event export of an
  // unrenderable window would serve corrupt `NaN` instants, so it 404s.
  if (!row || !isRenderableEventWindow(row)) return null;
  return row;
}

export type PublicApiEvent = Omit<PublicEvent, "goingCount" | "goingOccupancy"> & {
  goingCount: number | null;
  goingOccupancy?: number | null;
};

/**
 * A3 public-API collection: published-only with the same clamp-to-last-page
 * bound as `listJson`, but the going-count aggregate degrades to null instead
 * of failing the page — an unreadable RSVP rollup reads as unknown, never 0.
 * `listJson` stays untouched for the session-gated `/events.json` contract.
 */
export async function listPublicApiEvents(
  db: Db,
  opts: { limit: number; offset: number },
): Promise<{ rows: PublicApiEvent[]; total: number; page: number }> {
  const predicate = eq(events.status, PUBLIC_EVENT_STATUS);
  const [total] = await db.select({ n: count() }).from(events).where(predicate);
  const n = Number(total?.n ?? 0);
  const lastPage = Math.max(1, Math.ceil(n / opts.limit));
  const page = Math.min(Math.max(1, Math.floor(opts.offset / opts.limit) + 1), lastPage);
  const rows = await db
    .select()
    .from(events)
    .where(predicate)
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(opts.limit)
    .offset((page - 1) * opts.limit);
  const renderable = rows.filter(isRenderableEventWindow);
  const withCounts = await withGoing(db, renderable).catch(() =>
    renderable.map((row) => ({
      ...row,
      goingCount: null as number | null,
      goingOccupancy: null as number | null,
    })),
  );
  return { rows: withCounts, total: n, page };
}

/** A3 public-API single: published rows only — drafts, cancelled rows and unrenderable windows are all a 404 upstream. */
export async function getPublicApiEvent(db: Db, eventKey: string): Promise<PublicApiEvent | null> {
  const row = await getEventRow(db, eventKey);
  if (!row || row.status !== PUBLIC_EVENT_STATUS) return null;
  const [withCount] = await withGoing(db, [row]).catch(() => [
    { ...row, goingCount: null as number | null, goingOccupancy: null as number | null },
  ]);
  return withCount ?? { ...row, goingCount: null, goingOccupancy: null };
}
