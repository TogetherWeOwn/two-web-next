import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { events, rsvps } from "../db/admin-schema";
import { waitlistOffers } from "../db/dormant-schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Dormant helper; callers own a READ COMMITTED transaction. No notification is sent. */
export async function createWaitlistOffer(tx: Tx, rsvpId: number) {
  // A transaction-wide snapshot can miss a hold committed while acquiring locks.
  const [isolation] = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (isolation?.level !== "read committed") {
    throw new Error("Waitlist offers require a READ COMMITTED transaction");
  }
  // Discover the event without holding a row lock, then follow the existing
  // event-before-RSVP order. Revalidate the RSVP after acquiring both locks.
  const [candidate] = await tx
    .select({ eventId: rsvps.eventId })
    .from(rsvps)
    .where(eq(rsvps.id, rsvpId));
  if (!candidate) return null;
  const [event] = await tx
    .select()
    .from(events)
    .where(eq(events.id, candidate.eventId))
    .for("update");
  if (!event) return null;
  const line = await tx
    .select({ id: rsvps.id, status: rsvps.status })
    .from(rsvps)
    .where(eq(rsvps.eventId, event.id))
    .orderBy(asc(rsvps.id))
    .for("update");
  const ids = line.map((row) => row.id);
  if (!ids.includes(rsvpId)) return null;
  const eventRsvps = tx.select({ id: rsvps.id }).from(rsvps).where(eq(rsvps.eventId, event.id));
  await tx
    .select({ id: waitlistOffers.id })
    .from(waitlistOffers)
    .where(inArray(waitlistOffers.rsvpId, eventRsvps))
    .orderBy(asc(waitlistOffers.id))
    .for("update");
  // Preserve the database's microseconds across every comparison and stamp.
  // Transaction-start now() could precede a long row-lock wait.
  const [clock] = await tx
    .select({ now: sql<string>`clock_timestamp()::text` })
    .from(events)
    .where(eq(events.id, event.id));
  const now = sql`${clock!.now}::timestamptz`;
  await tx
    .update(waitlistOffers)
    .set({ state: "expired", updatedAt: now })
    .where(
      and(
        inArray(waitlistOffers.rsvpId, eventRsvps),
        eq(waitlistOffers.state, "held"),
        lte(waitlistOffers.expiresAt, now),
      ),
    );
  const [eligible] = await tx
    .select({ open: sql<boolean>`${events.startsAt} > ${now}` })
    .from(events)
    .where(eq(events.id, event.id));
  if (
    event.status !== "published" ||
    !event.rsvpOpen ||
    !eligible?.open ||
    line.find((row) => row.id === rsvpId)?.status !== "waitlisted"
  )
    return null;
  const held = await tx
    .select()
    .from(waitlistOffers)
    .where(and(inArray(waitlistOffers.rsvpId, eventRsvps), eq(waitlistOffers.state, "held")));
  const existing = held.find((offer) => offer.rsvpId === rsvpId);
  if (existing) return existing;
  if (
    event.capacity !== null &&
    line.filter((row) => row.status === "going").length + held.length >= event.capacity
  )
    return null;
  const [offer] = await tx
    .insert(waitlistOffers)
    .values({
      rsvpId,
      state: "held",
      offeredAt: now,
      expiresAt: sql`least(${now} + interval '2 hours', (select starts_at from events where id = ${event.id}))`,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return offer!;
}
