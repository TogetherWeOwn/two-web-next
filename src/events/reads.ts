// Public event reads (W8). Published-only unless the caller is a moderator.
import { and, asc, count, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { events, rsvps } from "../db/admin-schema";

export type PublicEvent = typeof events.$inferSelect & { goingCount: number };

export const PAGE_SIZE = 20;
export const JSON_DEFAULT_LIMIT = 20;
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

/** Upcoming = published and not yet ended, soonest first. */
export async function listUpcoming(db: Db, now = new Date()): Promise<PublicEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.status, "published"), gte(events.endsAt, now)))
    .orderBy(asc(events.startsAt));
  return withGoing(db, rows);
}

/** Past archive: ended (published-then-closed or already `past`), newest first, 20/page. */
export async function listPast(db: Db, page: number, now = new Date()): Promise<{ rows: PublicEvent[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(events)
    .where(or(eq(events.status, "past"), and(eq(events.status, "published"), lt(events.endsAt, now))))
    .orderBy(desc(events.startsAt))
    .limit(PAGE_SIZE + 1)
    .offset((Math.max(1, page) - 1) * PAGE_SIZE);
  return { rows: await withGoing(db, rows.slice(0, PAGE_SIZE)), hasMore: rows.length > PAGE_SIZE };
}

export async function getPublicEvent(db: Db, key: string): Promise<PublicEvent | null> {
  const [row] = await db.select().from(events).where(eq(events.eventKey, key));
  if (!row) return null;
  return (await withGoing(db, [row]))[0] ?? null;
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
