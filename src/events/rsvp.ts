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
import { retireAnonEventCaches } from "./anon-cache";
import { retireHomeGuestCache } from "../home-cache";
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

/**
 * Bounded advisory-lock wait for every RSVP write transaction. Each of the
 * three takes (write member lock, withdraw member lock, charge bucket lock)
 * carries a `lock_timeout` bound that covers only the take itself: the same
 * statement captures the prior value, sets the bound, takes the lock, then
 * restores the prior value, so later waits in the transaction (event and RSVP
 * row locks, lockWaitlist, promoteWaitlist) keep their wait-then-judge
 * semantics. A timed-out take (55P03, surfaced by drizzle on `cause`)
 * resolves to the existing limited verdict — never a 500. 5s keeps the ~3.2s
 * queued-write expiry control in test/rsvp-throttle-prune-batch.test.ts
 * judging normally (its member-lock wait still fits), while the 8s busy bound
 * in test/rsvp-lock-busy.test.ts settles well inside it. Same mechanism as
 * the join admission lock (`WEB_THROTTLE_LOCK_TIMEOUT_MS`) and the
 * agent-events shield/inner limiter.
 */
export const RSVP_LOCK_TIMEOUT_MS = 5000;

/** Lock-timeout (55P03) whether raised directly or wrapped by drizzle. */
function isLockTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === "55P03") return true;
  const cause = (err as { cause?: unknown })?.cause as { code?: unknown } | undefined;
  return cause?.code === "55P03";
}

/**
 * Take one `pg_advisory_xact_lock` with a bound scoped to the take itself.
 * `set_config(..., true)` is transaction-local, so without the restore the
 * bound would leak onto every later lock wait in the transaction (event and
 * RSVP row `FOR UPDATE`, waitlist head rows a mirror-stamp writer can hold
 * until after the event ends). The chained `MATERIALIZED` CTEs force
 * evaluation order — read the prior value, set the bound, take the lock,
 * then restore — in a single statement, so the pinned single-execute
 * sequences stay one statement per take.
 */
async function takeBoundedAdvisoryLock(tx: Tx, key: string): Promise<void> {
  await tx.execute(
    sql`with rsvp_lock_prev as materialized (select current_setting('lock_timeout') as v), rsvp_lock_cfg as materialized (select set_config('lock_timeout', ${`${RSVP_LOCK_TIMEOUT_MS}ms`}, true) from rsvp_lock_prev), rsvp_lock_take as materialized (select pg_advisory_xact_lock(hashtext(${key})) from rsvp_lock_cfg) select set_config('lock_timeout', (select v from rsvp_lock_prev), true) from rsvp_lock_take`,
  );
}

/** Draft/cancelled/past events and paused ones take no new answers (RsvpPolicy + TOG-8725).
 * The `now` below is always the post-lock database instant (see readDbClock),
 * never the caller's worker clock. */
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

/**
 * The one post-lock database instant for a verdict and its stamps. Read
 * `clock_timestamp()` inside the transaction after the event lock and the
 * waitlist/prune waits, so expiry and every stamp share the database clock
 * the row locks were taken under — not transaction-start `now()` and not the
 * caller's worker clock. The `clock` param is the test seam and the fallback
 * for doubles that cannot answer the read (they resolve to no row, and the
 * verdict falls back to the injected instant).
 */
async function readDbClock(tx: Tx, clock: () => Date, eventId: number): Promise<Date> {
  try {
    // This drizzle version only executes a select anchored on a table, so the
    // projection rides on the locked event row (which the caller verified
    // exists) rather than a bare `select clock_timestamp()`.
    const [row] = (await tx
      .select({ now: sql`clock_timestamp()` })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1)) as unknown as Array<{ now: unknown }>;
    const v = row?.now;
    const at = v instanceof Date ? v : v == null ? null : new Date(v as string | number);
    if (at && !Number.isNaN(at.getTime())) return at;
  } catch {
    // Fall through to the injected clock below.
  }
  return clock();
}
export async function writeRsvp(
  db: Db,
  eventKey: string,
  userId: string,
  status: RsvpWriteStatus,
  clock: () => Date = () => new Date(),
): Promise<RsvpWriteResult> {
  let result: RsvpWriteResult;
  try {
    result = await db.transaction(async (tx) => {
      // Member lock first, then the event row lock (withdraw takes the same order, so the
      // order cannot deadlock). The take is bounded and self-scoped (see
      // takeBoundedAdvisoryLock): without the timeout a bucket whose advisory
      // lock is held by another transaction blocks here until the holder
      // commits, and the restore keeps the bound off the row waits below.
      await takeBoundedAdvisoryLock(tx, `rsvp-write:${userId}`);
      const [ev] = await tx
        .select()
        .from(events)
        .where(eq(events.eventKey, eventKey))
        .for("update");
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
      // Judge expiry on the database clock read after every wait above.
      const dbNow = await readDbClock(tx, clock, ev.id);
      const why = closedWhy(ev, dbNow);
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
        // Sibling stamps share the database clock: full-precision
        // clock_timestamp() for fresh FIFO keys (never transaction-start now()
        // or a skewed/millisecond Worker Date) beside the same post-lock
        // instant for the updated stamp.
        .values({
          eventId: ev.id,
          userId,
          status: settledStatus,
          syncedToDiscordAt: null,
          createdAt: sql`clock_timestamp()`,
          updatedAt: dbNow,
        })
        .onConflictDoUpdate({
          target: [rsvps.eventId, rsvps.userId],
          set: { status: settledStatus, syncedToDiscordAt: null, updatedAt: dbNow },
        });
      // Non-seat answers and Going re-answers leave the existing line untouched.
      // New seat requests still settle FIFO, including explicit stale-view joins.
      // Promotion judges and stamps on the same post-lock instant: freeze the
      // database clock for the waitlist pass instead of the worker clock.
      const releasesSeat = existing?.status === "going" && status !== "going";
      if (releasesSeat || settledStatus === "waitlisted")
        await promoteWaitlist(tx, ev, () => dbNow);
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
  } catch (err) {
    // Contention on the member's own lock is that member's own parallel
    // burst, which the shared budget exists to refuse: a timed-out wait
    // resolves to the existing limited verdict with no hit charged (the
    // verdict transaction aborted), never a 500. Any other store error
    // still propagates. The routes call this with no lock-error catch of
    // their own, so the mapping lives here.
    if (!isLockTimeout(err)) throw err;
    result = { ok: false, reason: "limited", retryAfter: 1 } as const;
  }
  // Committed with a new answer: the going count guests read may have moved
  // (N6). Refusals (closed/limited/not_found) change nothing and keep entries.
  if (result.ok) {
    retireAnonEventCaches();
    await retireHomeGuestCache();
  }
  return result;
}

/** Quiet by design: no row, unknown event or cancelled event all answer the same. */
export async function withdrawRsvp(
  db: Db,
  eventKey: string,
  userId: string,
  clock: () => Date = () => new Date(),
): Promise<
  | { limited: false; deleted: boolean; status: EventStatus | null }
  | { limited: true; retryAfter: number }
> {
  let result:
    | { limited: false; deleted: boolean; status: EventStatus | null }
    | { limited: true; retryAfter: number };
  try {
    result = await db.transaction(async (tx) => {
      // Same lock order as writeRsvp (member, then event row); the budget hit is stamped and
      // committed together with the delete, after both waits. Bounded,
      // self-scoped take (see takeBoundedAdvisoryLock): only the member take
      // carries the timeout, so the row waits below keep theirs.
      await takeBoundedAdvisoryLock(tx, `rsvp-write:${userId}`);
      const [ev] = await tx
        .select()
        .from(events)
        .where(eq(events.eventKey, eventKey))
        .for("update");
      // Unknown keys change nothing, so they cost nothing: return before the
      // throttle prune/charge, mirroring writeRsvp's not_found path.
      if (!ev) return { limited: false, deleted: false, status: null } as const;
      // Own row, promotion rows and maintenance can all wait on other writers.
      // Take them before the hit is stamped so an accepted debit stays fresh.
      await tx
        .select({ id: rsvps.id })
        .from(rsvps)
        .where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId)))
        .for("update");
      if (ev.status === "published" && ev.rsvpOpen) await lockWaitlist(tx, ev.id);
      await pruneThrottle(tx);
      // Freeze the same post-lock database instant for the promotion pass below,
      // so its expiry check and stamps never see the worker clock.
      const dbNow = await readDbClock(tx, clock, ev.id);
      const verdict = await chargeThrottle(tx, userId);
      if (verdict.limited) return { limited: true, retryAfter: verdict.retryAfter } as const;
      const gone = await tx
        .delete(rsvps)
        .where(and(eq(rsvps.eventId, ev.id), eq(rsvps.userId, userId)))
        .returning({ id: rsvps.id });
      if (gone.length > 0) await promoteWaitlist(tx, ev, () => dbNow);
      const mirrorable = ev.status === "published" || ev.status === "cancelled";
      return {
        limited: false,
        deleted: gone.length > 0,
        status: gone.length > 0 && mirrorable ? (ev.status as EventStatus) : null,
      } as const;
    });
  } catch (err) {
    // Same busy mapping as writeRsvp: contention is the member's own burst,
    // refused with the shared limited verdict and no hit charged, never a
    // 500. Other store errors still propagate.
    if (!isLockTimeout(err)) throw err;
    result = { limited: true, retryAfter: 1 } as const;
  }
  // Committed with a deleted row: the count and the settled line moved (N6).
  // A no-row or limited delete changes nothing and keeps entries.
  if (!result.limited && result.deleted) {
    retireAnonEventCaches();
    await retireHomeGuestCache();
  }
  return result;
}

export type Verdict = { limited: false } | { limited: true; retryAfter: number };

/**
 * The single per-member write budget: 12 / 60 s, keyed on the member (not IP), shared by
 * PUT and DELETE and across events, so switching verb or path cannot multiply it. The
 * advisory lock makes count-then-insert atomic per bucket, so a concurrent burst cannot
 * overshoot (the Laravel limiter is cache-backed and best-effort; this is stricter).
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Bounded global maintenance: one capped skip-locked batch per write (1000, the
 * established cleanup batch), so it must run before any accept/charge decision. */
async function pruneThrottle(tx: Tx): Promise<void> {
  await tx.execute(
    sql`with candidates as (select id from web_throttle_hits where at < clock_timestamp() - make_interval(mins => ${THROTTLE_COUNTER_RETENTION_MINUTES}) order by id limit 1000 for update skip locked) delete from web_throttle_hits using candidates where web_throttle_hits.id = candidates.id`,
  );
}

async function chargeThrottle(tx: Tx, userId: string): Promise<Verdict> {
  const bucket = `rsvp-write:${userId}`;
  const { maxAttempts, decaySeconds } = RSVP_RATE_LIMIT;
  {
    // Third take (same bucket key the outer transaction already holds):
    // re-assert the bound so the charge stays bounded even if a future
    // caller reaches it without the outer take. Self-scoped like the outer
    // takes, so the count and insert below keep their waits.
    await takeBoundedAdvisoryLock(tx, bucket);
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
