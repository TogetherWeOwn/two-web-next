// W9 RSVP write service. Ports two-web EventService::rsvp/withdrawRsvp, RsvpPolicy::create
// and App\Support\RsvpRateLimit.
//
// Concurrency: both verbs lock the event row (`SELECT ... FOR UPDATE`) inside one
// transaction, so capacity checks and status flips for one event are serialised — the
// loser of a race for the last seat re-reads the count after the winner commits and joins
// the waitlist. Same Postgres, same lock as Laravel's lockForUpdate().
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { events, rsvps } from "../db/admin-schema";
import { RSVP_RATE_LIMIT, RSVP_STATUSES, type RsvpWriteStatus } from "../islands/contracts";
import { THROTTLE_COUNTER_RETENTION_MINUTES } from "../join/service";
import { enqueueEventSync } from "./sync";
import { lockWaitlist, promoteWaitlist, waitlistPosition } from "./waitlist";
import type { Env } from "../env";
import type { EventStatus } from "../admin/validation";

export const isRsvpStatus = (v: unknown): v is RsvpWriteStatus =>
  (RSVP_STATUSES as readonly unknown[]).includes(v);

export type RsvpAnswer = {
  status: RsvpWriteStatus;
  syncedToDiscordAt: Date | null;
  waitlistPosition: number | null;
};
export type RsvpWriteResult =
  | {
      ok: true;
      created: boolean;
      answer: RsvpAnswer;
      mirrored: EventStatus | null;
      eventKey: string;
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "closed"; why: "draft" | "cancelled" | "past" | "paused" }
  | { ok: false; reason: "limited"; retryAfter: number };

/** Draft/cancelled/past events and paused ones take no new answers (RsvpPolicy + TOG-8725). */
function closedWhy(
  ev: { status: string; endsAt: Date; rsvpOpen: boolean },
  now: Date,
): "draft" | "cancelled" | "past" | "paused" | null {
  if (ev.status !== "published")
    return ev.status === "cancelled" ? "cancelled" : ev.status === "draft" ? "draft" : "past";
  if (ev.endsAt <= now) return "past";
  if (!ev.rsvpOpen) return "paused";
  return null;
}
export async function writeRsvp(
  db: Db,
  eventKey: string,
  userId: string,
  status: RsvpWriteStatus,
  clock: () => Date = () => new Date(),
): Promise<RsvpWriteResult> {
  return db.transaction(async (tx) => {
    // Member lock first, then the event row lock (withdraw takes the same order, so the
    // order cannot deadlock).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rsvp-write:${userId}`}))`);
    const [ev] = await tx.select().from(events).where(eq(events.eventKey, eventKey)).for("update");
    if (!ev) return { ok: false, reason: "not_found" } as const;
    // The RSVP row lock comes before any accept/charge decision: a wait on a mirror-stamp
    // writer must finish before the clock is read, or an answer could slip in after the
    // event has ended. Empty for a first answer, which has no row to wait on.
    const [existing] = await tx
      .select()
      .from(rsvps)
      .where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId)))
      .for("update");
    // Promotion can wait on another member's mirror-stamp writer. Finish that wait
    // and the global prune before judging expiry or stamping the budget hit.
    if (ev.status === "published" && ev.rsvpOpen) await lockWaitlist(tx, ev.id);
    await pruneThrottle(tx);
    const now = clock();
    const why = closedWhy(ev, now);
    if (why) return { ok: false, reason: "closed", why } as const;
    // Every new seat request joins the line before allocation, even with a vacancy.
    // The same FIFO pass handles explicit waitlist answers from a stale full view;
    // neither can bypass an accepted head. Existing holders retain their seat.
    const settledStatus =
      status === "going" && existing?.status !== "going" ? "waitlisted" : status;
    // Budget is charged only for an accepted write, including a waitlist answer.
    // Policy, the hit and the write share the same transaction and event lock.
    const verdict = await chargeThrottle(tx, userId);
    if (verdict.limited)
      return { ok: false, reason: "limited", retryAfter: verdict.retryAfter } as const;
    // Joining from an older non-waitlisted answer is a new place, not its old priority.
    // Recreate both FIFO keys so even equal timestamps cannot jump existing waiters.
    if (settledStatus === "waitlisted" && existing && existing.status !== "waitlisted") {
      await tx.delete(rsvps).where(eq(rsvps.id, existing.id));
    }
    // Any change makes the Discord mirror stale again.
    await tx
      .insert(rsvps)
      // Use the database's post-lock clock and full precision for fresh FIFO keys,
      // not transaction-start now() or a skewed/millisecond Worker Date.
      .values({
        eventId: ev.id,
        userId,
        status: settledStatus,
        syncedToDiscordAt: null,
        createdAt: sql`clock_timestamp()`,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [rsvps.eventId, rsvps.userId],
        set: { status: settledStatus, syncedToDiscordAt: null, updatedAt: now },
      });
    // Non-seat answers and Going re-answers leave the existing line untouched.
    // New seat requests still settle FIFO, including explicit stale-view joins.
    const releasesSeat = existing?.status === "going" && status !== "going";
    if (releasesSeat || settledStatus === "waitlisted") await promoteWaitlist(tx, ev, clock);
    // Return the committed allocation, including callers that promoted themselves.
    const [row] = await tx
      .select()
      .from(rsvps)
      .where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId)));
    return {
      ok: true,
      created: !existing,
      answer: {
        status: row!.status as RsvpWriteStatus,
        syncedToDiscordAt: row!.syncedToDiscordAt,
        waitlistPosition:
          row!.status === "waitlisted" ? await waitlistPosition(tx, ev.id, userId) : null,
      },
      mirrored: "published",
      eventKey: ev.eventKey,
    } as const;
  });
}

/** Quiet by design: no row, unknown event or cancelled event all answer the same. */
export async function withdrawRsvp(
  db: Db,
  eventKey: string,
  userId: string,
): Promise<
  | { limited: false; deleted: boolean; status: EventStatus | null }
  | { limited: true; retryAfter: number }
> {
  return db.transaction(async (tx) => {
    // Same lock order as writeRsvp (member, then event row); the budget hit is stamped and
    // committed together with the delete, after both waits.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rsvp-write:${userId}`}))`);
    const [ev] = await tx.select().from(events).where(eq(events.eventKey, eventKey)).for("update");
    if (!ev) {
      await pruneThrottle(tx);
      const verdict = await chargeThrottle(tx, userId);
      return verdict.limited
        ? ({ limited: true, retryAfter: verdict.retryAfter } as const)
        : ({ limited: false, deleted: false, status: null } as const);
    }
    // Own row, promotion rows and maintenance can all wait on other writers.
    // Take them before the hit is stamped so an accepted debit stays fresh.
    await tx
      .select({ id: rsvps.id })
      .from(rsvps)
      .where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId)))
      .for("update");
    if (ev.status === "published" && ev.rsvpOpen) await lockWaitlist(tx, ev.id);
    await pruneThrottle(tx);
    const verdict = await chargeThrottle(tx, userId);
    if (verdict.limited) return { limited: true, retryAfter: verdict.retryAfter } as const;
    const gone = await tx
      .delete(rsvps)
      .where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId)))
      .returning({ id: rsvps.id });
    if (gone.length > 0) await promoteWaitlist(tx, ev);
    const mirrorable = ev.status === "published" || ev.status === "cancelled";
    return {
      limited: false,
      deleted: gone.length > 0,
      status: gone.length > 0 && mirrorable ? (ev.status as EventStatus) : null,
    } as const;
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
  await tx.execute(
    sql`delete from web_throttle_hits where at < clock_timestamp() - make_interval(mins => ${THROTTLE_COUNTER_RETENTION_MINUTES})`,
  );
}

async function chargeThrottle(tx: Tx, userId: string): Promise<Verdict> {
  const bucket = `rsvp-write:${userId}`;
  const { maxAttempts, decaySeconds } = RSVP_RATE_LIMIT;
  {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${bucket}))`);
    // The own/promotion row locks and global prune ran before this final decision.
    // Count and insert here so the window is judged fresh; policy-refused writes
    // return before this point and spend nothing.
    const rows = (await tx.execute(sql`
      select count(*)::int as n,
        coalesce(ceil(extract(epoch from (min(at) + make_interval(secs => ${decaySeconds}) - clock_timestamp()))), 1)::int as wait
      from web_throttle_hits where bucket = ${bucket} and at > clock_timestamp() - make_interval(secs => ${decaySeconds})`)) as unknown as {
      n: number;
      wait: number;
    }[];
    const r = rows[0];
    if (r && r.n >= maxAttempts) return { limited: true, retryAfter: Math.max(1, r.wait) } as const;
    await tx.execute(
      sql`insert into web_throttle_hits (bucket, at) values (${bucket}, clock_timestamp())`,
    );
    return { limited: false } as const;
  }
}

export async function dispatchRsvpSync(
  env: Env,
  eventKey: string,
  status: EventStatus | null,
  requestId?: string,
): Promise<void> {
  if (status) await enqueueEventSync(env, eventKey, status, requestId);
}
