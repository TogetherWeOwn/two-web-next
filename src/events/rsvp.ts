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
export async function writeRsvp(db: Db, eventKey: string, userId: string, status: RsvpWriteStatus, clock: () => Date = () => new Date()): Promise<RsvpWriteResult> {
  return db.transaction(async (tx) => {
    const [ev] = await tx.select().from(events).where(eq(events.eventKey, eventKey)).for("update");
    if (!ev) return { ok: false, reason: "not_found" } as const;
    // Read the clock only once the row lock is held: a wait behind a lock holder must not
    // let an answer slip in after the event has ended.
    const now = clock();
    if (ev.status !== "published") return { ok: false, reason: "closed", why: ev.status === "cancelled" ? "cancelled" : ev.status === "draft" ? "draft" : "past" } as const;
    if (ev.endsAt <= now) return { ok: false, reason: "closed", why: "past" } as const;
    if (!ev.rsvpOpen) return { ok: false, reason: "closed", why: "paused" } as const;

    const [existing] = await tx.select().from(rsvps).where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId)));
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
export async function withdrawRsvp(db: Db, eventKey: string, userId: string): Promise<{ deleted: boolean; status: EventStatus | null }> {
  return db.transaction(async (tx) => {
    const [ev] = await tx.select().from(events).where(eq(events.eventKey, eventKey)).for("update");
    if (!ev) return { deleted: false, status: null };
    const gone = await tx.delete(rsvps).where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId))).returning({ id: rsvps.id });
    const mirrorable = ev.status === "published" || ev.status === "cancelled";
    return { deleted: gone.length > 0, status: gone.length > 0 && mirrorable ? (ev.status as EventStatus) : null };
  });
}

export type Verdict = { limited: false } | { limited: true; retryAfter: number };

/**
 * The single per-member write budget: 12 / 60 s, keyed on the member (not IP), shared by
 * PUT and DELETE and across events, so switching verb or path cannot multiply it. The
 * advisory lock makes count-then-insert atomic per bucket, so a concurrent burst cannot
 * overshoot (the Laravel limiter is cache-backed and best-effort; this is stricter).
 */
export async function hitRsvpThrottle(db: Db, userId: string): Promise<Verdict> {
  return db.transaction((tx) => chargeThrottle(tx, userId));
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function chargeThrottle(tx: Tx, userId: string): Promise<Verdict> {
  const bucket = `rsvp-write:${userId}`;
  const { maxAttempts, decaySeconds } = RSVP_RATE_LIMIT;
  {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${bucket}))`);
    const rows = (await tx.execute(sql`
      select count(*)::int as n,
        coalesce(ceil(extract(epoch from (min(at) + make_interval(secs => ${decaySeconds}) - now()))), 1)::int as wait
      from web_throttle_hits where bucket = ${bucket} and at > now() - make_interval(secs => ${decaySeconds})`)) as unknown as { n: number; wait: number }[];
    const r = rows[0];
    if (r && r.n >= maxAttempts) return { limited: true, retryAfter: Math.max(1, r.wait) } as const;
    await tx.execute(sql`insert into web_throttle_hits (bucket) values (${bucket})`);
    await tx.execute(sql`delete from web_throttle_hits where at < now() - interval '5 minutes'`);
    return { limited: false } as const;
  }
}

export async function dispatchRsvpSync(env: Env, eventKey: string, status: EventStatus | null): Promise<void> {
  if (status) await enqueueEventSync(env, eventKey, status);
}
