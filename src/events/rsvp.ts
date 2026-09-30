// W9 RSVP write service. Ports two-web EventService::rsvp/withdrawRsvp, RsvpPolicy::create
// and App\Support\RsvpRateLimit.
//
// Concurrency: both verbs lock the event row (`SELECT ... FOR UPDATE`) inside one
// transaction, so capacity checks and status flips for one event are serialised — the
// loser of a race for the last seat re-reads the count after the winner commits and gets
// `at_capacity`. Same Postgres, same lock as Laravel's lockForUpdate().
import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { events, rsvps } from "../db/admin-schema";
import { RSVP_RATE_LIMIT, RSVP_STATUSES, type RsvpWriteStatus } from "../islands/contracts";
import { enqueueEventSync } from "./sync";
import type { Env } from "../env";
import type { EventStatus } from "../admin/validation";

export const isRsvpStatus = (v: unknown): v is RsvpWriteStatus => (RSVP_STATUSES as readonly unknown[]).includes(v);

export type RsvpAnswer = { status: RsvpWriteStatus; syncedToDiscordAt: Date | null };
export type RsvpWriteResult =
  | { ok: true; created: boolean; answer: RsvpAnswer; mirrored: EventStatus | null; eventKey: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "closed"; why: "draft" | "cancelled" | "past" | "paused" }
  | { ok: false; reason: "at_capacity"; capacity: number }
  | { ok: false; reason: "limited"; retryAfter: number };

/** Draft/cancelled/past events and paused ones take no new answers (RsvpPolicy + TOG-8725). */
function closedWhy(ev: { status: string; endsAt: Date; rsvpOpen: boolean }, now: Date): "draft" | "cancelled" | "past" | "paused" | null {
  if (ev.status !== "published") return ev.status === "cancelled" ? "cancelled" : ev.status === "draft" ? "draft" : "past";
  if (ev.endsAt <= now) return "past";
  if (!ev.rsvpOpen) return "paused";
  return null;
}
export async function writeRsvp(db: Db, eventKey: string, userId: string, status: RsvpWriteStatus, clock: () => Date = () => new Date()): Promise<RsvpWriteResult> {
  return db.transaction(async (tx) => {
    // Member lock first, then the event row lock (withdraw takes the same order, so the
    // order cannot deadlock).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rsvp-write:${userId}`}))`);
    const [ev] = await tx.select().from(events).where(eq(events.eventKey, eventKey)).for("update");
    if (!ev) return { ok: false, reason: "not_found" } as const;
    // The RSVP row lock comes before any accept/charge decision: a wait on a mirror-stamp
    // writer must finish before the clock is read, or an answer could slip in after the
    // event has ended. Empty for a first answer, which has no row to wait on.
    const [existing] = await tx.select().from(rsvps).where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId)))
      .for("update");
    // Blocking maintenance BEFORE the final decision: the global prune can wait on a
    // contended expired row, and a wait after the clock is read would let an answer slip
    // in after the event ends. The event row is locked above, so its columns cannot change
    // under us while we wait; only the clock moves. Read it once all waits — member,
    // event, RSVP row, prune — are behind us and judge expiry then.
    await pruneThrottle(tx);
    const now = clock();
    const why = closedWhy(ev, now);
    if (why) return { ok: false, reason: "closed", why } as const;
    // Only an answer that newly takes a seat has to fit.
    const takesASeat = status === "going" && existing?.status !== "going";
    if (takesASeat && ev.capacity !== null) {
      const [tally] = await tx.select({ n: count() }).from(rsvps).where(and(eq(rsvps.eventId, ev.id), eq(rsvps.status, "going")));
      if (Number(tally?.n ?? 0) >= ev.capacity) return { ok: false, reason: "at_capacity", capacity: ev.capacity } as const;
    }
    // Budget is charged only for a write that is accepted: policy and capacity are decided
    // above under the row lock, the hit and the write commit together below.
    const verdict = await chargeThrottle(tx, userId);
    if (verdict.limited) return { ok: false, reason: "limited", retryAfter: verdict.retryAfter } as const;
    // Any change makes the Discord mirror stale again.
    const [row] = await tx
      .insert(rsvps)
      .values({ eventId: ev.id, userId, status, syncedToDiscordAt: null })
      .onConflictDoUpdate({ target: [rsvps.eventId, rsvps.userId], set: { status, syncedToDiscordAt: null, updatedAt: now } })
      .returning();
    return {
      ok: true,
      created: !existing,
      answer: { status: row!.status as RsvpWriteStatus, syncedToDiscordAt: row!.syncedToDiscordAt },
      mirrored: "published",
      eventKey: ev.eventKey,
    } as const;
  });
}

/** Quiet by design: no row, unknown event or cancelled event all answer the same. */
export async function withdrawRsvp(db: Db, eventKey: string, userId: string): Promise<{ limited: false; deleted: boolean; status: EventStatus | null } | { limited: true; retryAfter: number }> {
  return db.transaction(async (tx) => {
    // Same lock order as writeRsvp (member, then event row); the budget hit is stamped and
    // committed together with the delete, after both waits.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rsvp-write:${userId}`}))`);
    const [ev] = await tx.select().from(events).where(eq(events.eventKey, eventKey)).for("update");
    if (!ev) {
      await pruneThrottle(tx);
      const verdict = await chargeThrottle(tx, userId);
      return verdict.limited ? ({ limited: true, retryAfter: verdict.retryAfter } as const) : ({ limited: false, deleted: false, status: null } as const);
    }
    // Blocking maintenance before the row-lock wait: the global prune can wait on a
    // contended expired row, and a wait after the hit is stamped would age the accepted
    // write out of its window. Take the RSVP row lock only after it: a wait on a
    // mirror-stamp writer must finish before the hit is stamped.
    await pruneThrottle(tx);
    await tx.select({ id: rsvps.id }).from(rsvps).where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId))).for("update");
    const verdict = await chargeThrottle(tx, userId);
    if (verdict.limited) return { limited: true, retryAfter: verdict.retryAfter } as const;
    const gone = await tx.delete(rsvps).where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId))).returning({ id: rsvps.id });
    const mirrorable = ev.status === "published" || ev.status === "cancelled";
    return { limited: false, deleted: gone.length > 0, status: gone.length > 0 && mirrorable ? (ev.status as EventStatus) : null } as const;
  });
}

export type Verdict = { limited: false } | { limited: true; retryAfter: number };

/**
 * The single per-member write budget: 12 / 60 s, keyed on the member (not IP), shared by
 * PUT and DELETE and across events, so switching verb or path cannot multiply it. The
 * advisory lock makes count-then-insert atomic per bucket, so a concurrent burst cannot
 * overshoot (the Laravel limiter is cache-backed and best-effort; this is stricter).
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Global maintenance: prunes expired hits. Can block on a contended expired row, so it
 * must run before any accept/charge decision — never between the debit and the write. */
async function pruneThrottle(tx: Tx): Promise<void> {
  await tx.execute(sql`delete from web_throttle_hits where at < clock_timestamp() - interval '5 minutes'`);
}

async function chargeThrottle(tx: Tx, userId: string): Promise<Verdict> {
  const bucket = `rsvp-write:${userId}`;
  const { maxAttempts, decaySeconds } = RSVP_RATE_LIMIT;
  {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${bucket}))`);
    // The global prune already ran before the final accept/charge decision (PUT runs it
    // ahead of the clock read; DELETE runs it ahead of the row lock wait). Counting and
    // inserting here, so the window is always judged fresh; refused writes return before
    // this point and spend nothing.
    const rows = (await tx.execute(sql`
      select count(*)::int as n,
        coalesce(ceil(extract(epoch from (min(at) + make_interval(secs => ${decaySeconds}) - clock_timestamp()))), 1)::int as wait
      from web_throttle_hits where bucket = ${bucket} and at > clock_timestamp() - make_interval(secs => ${decaySeconds})`)) as unknown as { n: number; wait: number }[];
    const r = rows[0];
    if (r && r.n >= maxAttempts) return { limited: true, retryAfter: Math.max(1, r.wait) } as const;
    await tx.execute(sql`insert into web_throttle_hits (bucket, at) values (${bucket}, clock_timestamp())`);
    return { limited: false } as const;
  }
}

export async function dispatchRsvpSync(env: Env, eventKey: string, status: EventStatus | null): Promise<void> {
  if (status) await enqueueEventSync(env, eventKey, status);
}
