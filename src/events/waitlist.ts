import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { rsvps, type Event } from "../db/admin-schema";

type SeatWriter = Pick<PgDatabase<PgQueryResultHKT>, "select" | "update">;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const CAPACITY_BELOW_GOING = "Capacity cannot be lower than the number of members already going.";

/** Call behind the event's FOR UPDATE lock, like every seat-changing write. */
export async function goingCount(tx: Pick<SeatWriter, "select">, eventId: number): Promise<number> {
  const [tally] = await tx.select({ n: count() }).from(rsvps)
    .where(and(eq(rsvps.eventId, eventId), eq(rsvps.status, "going")));
  return Number(tally?.n ?? 0);
}

/** One statement/snapshot; rank in Postgres so sub-millisecond FIFO keys stay exact.
 * Batch the collection read rather than adding a query for each of its 100 rows. */
export async function waitlistPositions(db: Pick<Db, "execute">, eventIds: number[], userId: string): Promise<Map<number, number>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db.execute(sql`
    select event_id, position from (
      select event_id, user_id, row_number() over (partition by event_id order by created_at, coalesce(legacy_id, id), id)::int as position
      from rsvps where event_id in (${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)}) and status = 'waitlisted'
    ) line where user_id = ${userId}`) as unknown as { event_id: number; position: number }[];
  return new Map(rows.map((row) => [row.event_id, row.position]));
}

export async function waitlistPosition(db: Pick<Db, "execute">, eventId: number, userId: string): Promise<number | null> {
  return (await waitlistPositions(db, [eventId], userId)).get(eventId) ?? null;
}

/** RSVP verbs must finish every promotion-row wait before checking expiry/debiting
 * the member budget. Lock the current line behind the event lock; accepted writes
 * can then settle any heads (including a new caller row) without another writer wait. */
export async function lockWaitlist(tx: Tx, eventId: number): Promise<void> {
  await tx.select({ id: rsvps.id }).from(rsvps)
    .where(and(eq(rsvps.eventId, eventId), eq(rsvps.status, "waitlisted")))
    .orderBy(asc(rsvps.createdAt), sql`coalesce(${rsvps.legacyId}, ${rsvps.id})`, asc(rsvps.id)).for("update");
}

/** Settle FIFO heads inside the caller's transaction and event-row lock, never after commit.
 * A paused/closed event freezes the line. Reset mirror stamps; the caller queues the event
 * write-back after commit, covering both its own write and every promoted answer. */
export async function promoteWaitlist(tx: SeatWriter, ev: Event, clock: () => Date = () => new Date()): Promise<void> {
  if (ev.status !== "published" || !ev.rsvpOpen || ev.endsAt <= clock()) return;
  const free = ev.capacity === null ? null : ev.capacity - await goingCount(tx, ev.id);
  if (free !== null && free <= 0) return;
  const query = tx.select({ id: rsvps.id }).from(rsvps)
    .where(and(eq(rsvps.eventId, ev.id), eq(rsvps.status, "waitlisted")))
    .orderBy(asc(rsvps.createdAt), sql`coalesce(${rsvps.legacyId}, ${rsvps.id})`, asc(rsvps.id)).for("update").$dynamic();
  const heads = await (free === null ? query : query.limit(free));
  const now = clock();
  // A mirror-stamp writer can hold a head row until after the event ends.
  if (heads.length === 0 || ev.endsAt <= now) return;
  await tx.update(rsvps).set({ status: "going", syncedToDiscordAt: null, updatedAt: now })
    .where(inArray(rsvps.id, heads.map((head) => head.id)));
}
