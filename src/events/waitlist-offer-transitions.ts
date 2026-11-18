import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { events, rsvps } from "../db/admin-schema";
import { waitlistOffers } from "../db/dormant-schema";
import type { Db } from "../db/index";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Uses the same event -> ordered RSVPs -> ordered offers lock order as creation.
// The caller owns the transaction and must commit or roll back all changes.
export async function claimWaitlistOffer(
  tx: Tx,
  eventId: number,
  rsvpId: number,
  userId: string,
  offerId: string,
) {
  if (!UUID.test(offerId)) return { ok: false as const, reason: "not_found" };
  const [isolation] = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (isolation?.level !== "read committed")
    throw new Error("Waitlist offers require a READ COMMITTED transaction");
  const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
  if (!event) return { ok: false as const, reason: "not_found" };
  const line = await tx
    .select()
    .from(rsvps)
    .where(eq(rsvps.eventId, eventId))
    .orderBy(asc(rsvps.id))
    .for("update");
  const rsvp = line.find((row) => row.id === rsvpId);
  if (!rsvp || rsvp.userId !== userId) return { ok: false as const, reason: "not_found" };
  const eventRsvps = tx.select({ id: rsvps.id }).from(rsvps).where(eq(rsvps.eventId, eventId));
  const offers = await tx
    .select()
    .from(waitlistOffers)
    .where(inArray(waitlistOffers.rsvpId, eventRsvps))
    .orderBy(asc(waitlistOffers.id))
    .for("update");
  const offer = offers.find((row) => row.id === offerId.toLowerCase() && row.rsvpId === rsvpId);
  if (!offer) return { ok: false as const, reason: "not_found" };
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  const now = sql`${clock!.now}::timestamptz`;
  const [times] = await tx
    .select({
      expired: sql<boolean>`${waitlistOffers.expiresAt} <= ${now}`,
      started: sql<boolean>`${events.startsAt} <= ${now}`,
    })
    .from(waitlistOffers)
    .innerJoin(events, eq(events.id, eventId))
    .where(eq(waitlistOffers.id, offer.id));
  if (offer.state === "accepted") return { ok: true as const, offer, replay: true };
  if (offer.state !== "held") return { ok: false as const, reason: "not_held" };
  if (times!.expired) return { ok: false as const, reason: "expired" };
  if (
    event.status !== "published" ||
    !event.rsvpOpen ||
    times!.started ||
    rsvp.status !== "waitlisted"
  )
    return { ok: false as const, reason: "unavailable" };
  if (
    event.capacity !== null &&
    line.filter((row) => row.status === "going").length >= event.capacity
  )
    return { ok: false as const, reason: "full" };
  await tx
    .update(rsvps)
    .set({ status: "going", syncedToDiscordAt: null, updatedAt: now })
    .where(eq(rsvps.id, rsvp.id));
  const [updated] = await tx
    .update(waitlistOffers)
    .set({ state: "accepted", updatedAt: now })
    .where(and(eq(waitlistOffers.id, offer.id), eq(waitlistOffers.rsvpId, rsvpId)))
    .returning();
  return { ok: true as const, offer: updated!, replay: false };
}

/** Dormant member action; userId must come from the authenticated session. */
export function declineWaitlistOffer(
  tx: Tx,
  eventId: number,
  rsvpId: number,
  userId: string,
  offerId: string,
) {
  return releaseWaitlistOffer(tx, eventId, rsvpId, offerId, { state: "declined", userId });
}

/** Dormant internal action; never expose this as a member mutation. */
export function expireWaitlistOffer(tx: Tx, eventId: number, rsvpId: number, offerId: string) {
  return releaseWaitlistOffer(tx, eventId, rsvpId, offerId, { state: "expired" });
}

async function releaseWaitlistOffer(
  tx: Tx,
  eventId: number,
  rsvpId: number,
  offerId: string,
  target: { state: "declined"; userId: string } | { state: "expired" },
) {
  if (!UUID.test(offerId)) return { ok: false as const, reason: "not_found" };
  const [isolation] = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (isolation?.level !== "read committed")
    throw new Error("Waitlist offers require a READ COMMITTED transaction");
  // Same order as claim; release does not need any other RSVP or offer rows.
  const [event] = await tx
    .select({ id: events.id })
    .from(events)
    .where(eq(events.id, eventId))
    .for("update");
  if (!event) return { ok: false as const, reason: "not_found" };
  const [rsvp] = await tx
    .select({ userId: rsvps.userId })
    .from(rsvps)
    .where(and(eq(rsvps.eventId, eventId), eq(rsvps.id, rsvpId)))
    .for("update");
  if (!rsvp || (target.state === "declined" && rsvp.userId !== target.userId))
    return { ok: false as const, reason: "not_found" };
  const match = and(eq(waitlistOffers.id, offerId), eq(waitlistOffers.rsvpId, rsvpId));
  const [offer] = await tx.select().from(waitlistOffers).where(match).for("update");
  if (!offer) return { ok: false as const, reason: "not_found" };
  if (offer.state === target.state) return { ok: true as const, offer, replay: true };
  if (offer.state !== "held") return { ok: false as const, reason: "not_held" };

  // Release only the hold; event eligibility and allocation belong to the caller.
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  const now = sql`${clock!.now}::timestamptz`;
  const declining = target.state === "declined";
  const [updated] = await tx
    .update(waitlistOffers)
    .set({ state: target.state, updatedAt: now })
    .where(
      and(
        match,
        declining ? gt(waitlistOffers.expiresAt, now) : lte(waitlistOffers.expiresAt, now),
      ),
    )
    .returning();
  if (!updated) return { ok: false as const, reason: declining ? "expired" : "not_due" };
  return { ok: true as const, offer: updated, replay: false };
}
