import { and, asc, eq, inArray, lte, notExists, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { events, rsvps } from "../db/admin-schema";
import { waitlistOffers } from "../db/dormant-schema";

export {
  claimWaitlistOffer,
  declineWaitlistOffer,
  expireWaitlistOffer,
} from "./waitlist-offer-transitions";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Dormant helper: replay a live hold or offer a seat only to the eligible FIFO head. */
export async function createWaitlistOffer(tx: Tx, rsvpId: number) {
  await requireReadCommitted(tx);
  // Discover the event without locking the RSVP ahead of it.
  const [candidate] = await tx
    .select({ eventId: rsvps.eventId })
    .from(rsvps)
    .where(eq(rsvps.id, rsvpId));
  if (!candidate) return null;
  return (await offerWaitlistSeats(tx, candidate.eventId, rsvpId))[0] ?? null;
}

/** Dormant FIFO pass. Returns only new holds, in queue order, for post-commit delivery. */
export async function allocateWaitlistOffers(tx: Tx, eventId: number) {
  await requireReadCommitted(tx);
  return offerWaitlistSeats(tx, eventId);
}

async function requireReadCommitted(tx: Tx) {
  // A transaction-wide snapshot can miss a hold committed while acquiring locks.
  const [isolation] = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (isolation?.level !== "read committed") {
    throw new Error("Waitlist offers require a READ COMMITTED transaction");
  }
}

async function offerWaitlistSeats(tx: Tx, eventId: number, rsvpId?: number) {
  const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
  if (!event) return [];
  const line = await tx
    .select({ id: rsvps.id, status: rsvps.status })
    .from(rsvps)
    .where(eq(rsvps.eventId, event.id))
    .orderBy(asc(rsvps.id))
    .for("update");
  const target = line.find((row) => row.id === rsvpId);
  if (rsvpId !== undefined && !target) return [];
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
  if (!eligible?.open || event.status !== "published" || !event.rsvpOpen) return [];
  if (target && target.status !== "waitlisted") return [];
  const held = await tx
    .select()
    .from(waitlistOffers)
    .where(and(inArray(waitlistOffers.rsvpId, eventRsvps), eq(waitlistOffers.state, "held")));
  const existing = held.find((offer) => offer.rsvpId === rsvpId);
  if (existing) return [existing];
  const free =
    event.capacity === null
      ? null
      : event.capacity - line.filter((row) => row.status === "going").length - held.length;
  if (free !== null && free <= 0) return [];

  // Decline/expiry consumes this place in line, not another chance at the
  // head. Rejoining creates a new RSVP. Keep FIFO comparisons in Postgres.
  const fifo = tx
    .select({ id: rsvps.id })
    .from(rsvps)
    .where(
      and(
        eq(rsvps.eventId, eventId),
        eq(rsvps.status, "waitlisted"),
        notExists(
          tx
            .select({ id: waitlistOffers.id })
            .from(waitlistOffers)
            .where(eq(waitlistOffers.rsvpId, rsvps.id)),
        ),
      ),
    )
    .orderBy(asc(rsvps.createdAt), sql`coalesce(${rsvps.legacyId}, ${rsvps.id})`, asc(rsvps.id));
  const limit = rsvpId === undefined ? free : 1;
  const heads = await (limit === null ? fifo : fifo.limit(limit));
  if (heads.length === 0 || (rsvpId !== undefined && heads[0]?.id !== rsvpId)) return [];
  const expiresAt = sql`least(${now} + interval '2 hours', (select starts_at from events where id = ${eventId}))`;
  const byRsvp = new Map<number, typeof waitlistOffers.$inferSelect>();
  // Unlimited events still need to stay below Postgres's bind parameter limit.
  for (let i = 0; i < heads.length; i += 1000) {
    const offers = await tx
      .insert(waitlistOffers)
      .values(
        heads.slice(i, i + 1000).map(({ id }) => ({
          rsvpId: id,
          state: "held",
          offeredAt: now,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .returning();
    for (const offer of offers) byRsvp.set(offer.rsvpId, offer);
  }
  return heads.map(({ id }) => byRsvp.get(id)!);
}
