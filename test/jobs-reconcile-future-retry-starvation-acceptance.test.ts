// Acceptance suite: a full page of not-yet-due (future) pending retries must
// not starve ready keys behind the reconcile page limit.
//
// Locked contract for the builder (this file is acceptance-owned; the builder
// must not edit it):
//
// 1. `EventStore.staleEventKeys(limit?: number, dueBefore?: Date)` gains an
//    optional scheduler-clock cutoff. When `dueBefore` is supplied, due
//    eligibility is applied inside the selection, BEFORE `ORDER BY event_key`
//    + `LIMIT`, across the complete candidate predicate:
//    - the attempted-pending recovery branch requires a non-null
//      `next_attempt_at <= dueBefore` (the exact deadline is due) with retry
//      budget left, exactly as today otherwise;
//    - the dirty-revision branch additionally excludes an event parked behind
//      ANY pending request that is not dispatchable at `dueBefore`: budget
//      spent, null deadline, or `next_attempt_at > dueBefore` (attempted or
//      not). A dirty revision therefore cannot re-enter the page early
//      through the dirty branch while its pending retry is still sleeping.
//    The supplied cutoff is the only clock the selection may use: never a
//    database wall clock (`clock_timestamp()`, `now()`, ...). Fixture times
//    below sit on both sides of the test database's wall clock, so a
//    DB-clock implementation fails this suite in both directions.
// 2. When `dueBefore` is omitted, selection keeps today's clock-free
//    semantics byte-for-byte: future pending retries stay stale in the
//    no-limit array shape and in the single-key path (`needsSync`,
//    `prepareSync`), which never receives a cutoff.
// 3. `reconcileEvents` passes its one supplied scheduler clock into the
//    scheduled selection: exactly one
//    `staleEventKeys(RECONCILE_REDISPATCH_PAGE_SIZE, <now>)` call per pass,
//    where `<now>` is the pass's injected `now()` value. The dispatch loop
//    keeps its existing per-key due check as a second fence, so a sleeping
//    request is never dispatched early even if a store returns it.
// 4. Page shape is unchanged: at most `limit` keys in ascending `event_key`
//    order. With a cutoff, `deferred` counts only due-eligible keys that
//    matched but were not returned; sleeping future retries are not deferred
//    work for this pass and never inflate the count (the same documented
//    semantics exhausted/null-deadline rows already have).
// 5. At the exact deadline the pending request becomes selectable and is
//    dispatched under its original immutable idempotency key. Exhausted and
//    null-deadline exclusions, deterministic ordering, the 200-key bound,
//    retention and terminal-intent handling are unchanged: a pass never
//    mutates, settles or deletes a sleeping/exhausted pending row.
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RECONCILE_REDISPATCH_PAGE_SIZE, SYNC_EVENT } from "../src/jobs/constants";
import { reconcileEvents } from "../src/jobs/cron";
import { pgEventStore } from "../src/jobs/events";
import type { EventStore, StaleEventKeysPage, SyncAttempt, UniqueLock } from "../src/jobs/types";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const NOW = new Date("2026-10-01T12:00:00Z");
const FUTURE = new Date("2026-10-01T13:00:00Z"); // one hour past the scheduler clock
const PAST = new Date("2026-10-01T11:00:00Z");

// The cut-off-aware shape this suite locks. Cast through it so the suite
// compiles against today's one-argument store and fails on behaviour, not
// on a type error.
type StaleWithCutoff = (limit?: number, dueBefore?: Date) => Promise<string[] | StaleEventKeysPage>;

const pageWith = async (
  store: EventStore,
  limit: number,
  dueBefore?: Date,
): Promise<StaleEventKeysPage> =>
  (await (store.staleEventKeys as StaleWithCutoff)(limit, dueBefore)) as StaleEventKeysPage;

function fakeLock(): UniqueLock {
  const held = new Set<string>();
  return {
    acquire: async (k) => (held.has(k) ? null : (held.add(k), crypto.randomUUID())),
    release: async (k) => void held.delete(k),
  };
}

function fakeQueue() {
  const sent: { eventKey: string; idempotencyKey: string }[] = [];
  return {
    sent,
    send: async (body: unknown) =>
      void sent.push(body as { eventKey: string; idempotencyKey: string }),
  };
}

const attempt = (over: Partial<SyncAttempt> & { eventKey: string }): SyncAttempt =>
  ({
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
    revision: 1,
    mirroredAt: PAST,
    state: "pending",
    requestAttempts: 1,
    nextAttemptAt: PAST,
    action: "event.upsert",
    payload: {
      eventKey: over.eventKey,
      name: "event",
      startsAt: "2026-10-01T10:00:00.000Z",
      endsAt: null,
      location: "hall",
      description: null,
    },
    ...over,
  }) as SyncAttempt;

function fakeStore(opts: { stale: string[]; pending?: Record<string, SyncAttempt | null> }) {
  const staleCalls: { limit?: number; dueBefore?: Date }[] = [];
  const store = {
    staleCalls,
    prepareSync: async () => null,
    completeSync: async () => {},
    claimSync: async () => null,
    deferSync: async () => {},
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async (k: string) => opts.pending?.[k] ?? null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async (limit?: number, dueBefore?: Date) => {
      staleCalls.push({ limit, dueBefore });
      return { keys: [...opts.stale], deferred: 0 };
    },
  };
  return store as typeof store & EventStore;
}

afterEach(() => vi.restoreAllMocks());

describe("future-retry starvation — reconcile wiring (hermetic)", () => {
  it("passes the one scheduler-clock cutoff into the scheduled selection, once per pass", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const events = fakeStore({ stale: ["ready"] });
    const queue = fakeQueue();

    const r = await reconcileEvents({ events, queue, lock: fakeLock(), now: () => NOW });

    expect(events.staleCalls).toEqual([{ limit: RECONCILE_REDISPATCH_PAGE_SIZE, dueBefore: NOW }]);
    expect(queue.sent.map((b) => b.eventKey)).toEqual(["ready"]);
    expect(r).toMatchObject({ resynced: 1, deferred: 0 });
  });

  it("control: the loop still never dispatches a sleeping request a store returns", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const events = fakeStore({
      stale: ["aaa-sleeping", "zzz-ready"],
      pending: {
        "aaa-sleeping": attempt({ eventKey: "aaa-sleeping", nextAttemptAt: FUTURE }),
      },
    });
    const queue = fakeQueue();

    const r = await reconcileEvents({ events, queue, lock: fakeLock(), now: () => NOW });

    expect(queue.sent.map((b) => b.eventKey)).toEqual(["zzz-ready"]);
    expect(r).toMatchObject({ resynced: 1, absorbed: 0, failed: 0 });
  });

  it("control: a due pending request dispatches under its original idempotency key", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const original = "55555555-5555-4555-8555-555555555555";
    const events = fakeStore({
      stale: ["due"],
      pending: {
        due: attempt({ eventKey: "due", idempotencyKey: original, nextAttemptAt: NOW }),
      },
    });
    const queue = fakeQueue();

    await reconcileEvents({ events, queue, lock: fakeLock(), now: () => NOW });

    expect(queue.sent).toEqual([
      expect.objectContaining({ eventKey: "due", idempotencyKey: original }),
    ]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "future-retry starvation — real pg store (agent-testdb)",
  () => {
    let fixture: JobsFixture | undefined;
    let sql: postgres.Sql;

    beforeAll(async () => {
      fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
      sql = fixture.client;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await sql`delete from rsvps`;
      await sql`delete from activity_log`;
      await sql`delete from events`;
    });

    const LEASE = "66666666-6666-4666-8666-666666666666";
    const memLock = (): UniqueLock => {
      const held = new Set<string>();
      return {
        acquire: async (k) => (held.has(k) ? null : (held.add(k), LEASE)),
        release: async (k, token) => {
          if (token === LEASE) held.delete(k);
        },
      };
    };

    async function seedPublished(eventKey: string): Promise<number> {
      const [row] = (await sql`insert into events
        (event_key, title, starts_at, ends_at, timezone, location, status, discord_event_id,
          recurrence_frequency, recurrence_count, parent_event_id, recurrence_index)
      values (${eventKey}, ${`event ${eventKey}`},
        ${new Date("2026-10-01T10:00:00Z")}, ${new Date("2026-10-01T14:00:00Z")},
        'Europe/London', 'hall', 'published', null, null, null, null, null)
      returning id`) as { id: number }[];
      return row!.id;
    }

    async function seedAttempt(
      eventId: number,
      opts: {
        attempts?: number;
        nextAttemptAt?: Date | null;
        idempotencyKey?: string;
        terminalReason?: string | null;
      } = {},
    ): Promise<void> {
      await sql`insert into event_sync_attempts
        (idempotency_key, event_id, revision, action, payload, mirrored_at, state,
          request_attempts, next_attempt_at, terminal_reason)
      select coalesce(${opts.idempotencyKey ?? null}::uuid, gen_random_uuid()),
        ${eventId}, sync_revision, 'event.upsert',
        jsonb_build_object('eventKey', event_key, 'name', title, 'startsAt', starts_at,
          'endsAt', ends_at, 'location', coalesce(location, ''), 'description', description),
        ${NOW}, 'pending', ${opts.attempts ?? 1},
        ${opts.nextAttemptAt === undefined ? FUTURE : opts.nextAttemptAt},
        ${opts.terminalReason ?? null}
      from events where id = ${eventId}`;
    }

    /** Mirrored and revision-acknowledged: stale only via pending recovery. */
    async function markClean(eventKey: string): Promise<void> {
      await sql`update events set discord_event_id = 'discord-' || event_key,
        synced_revision = sync_revision where event_key = ${eventKey}`;
    }

    it("a full page of future retries still reaches the ready key after them", async () => {
      const total = RECONCILE_REDISPATCH_PAGE_SIZE;
      await sql`insert into events
        (event_key, title, starts_at, ends_at, timezone, location, status, discord_event_id,
          recurrence_frequency, recurrence_count, parent_event_id, recurrence_index)
      select 'aaa-' || lpad(g::text, 3, '0'), 'event ' || g,
        timestamptz '2026-10-01 10:00:00+00', timestamptz '2026-10-01 14:00:00+00',
        'Europe/London', 'hall', 'published', null, null, null, null, null
      from generate_series(0, ${total - 1}) as g`;
      await sql`insert into event_sync_attempts
        (idempotency_key, event_id, revision, action, payload, mirrored_at, state, request_attempts, next_attempt_at)
      select gen_random_uuid(), id, sync_revision, 'event.upsert',
        jsonb_build_object('eventKey', event_key, 'name', title, 'startsAt', starts_at,
          'endsAt', ends_at, 'location', coalesce(location, ''), 'description', description),
        timestamptz '2026-10-01 12:00:00+00', 'pending', 1, ${FUTURE}
      from events where event_key like 'aaa-%'`;
      await seedPublished("zzz-ready");

      const store = pgEventStore(sql);
      const page = await pageWith(store, RECONCILE_REDISPATCH_PAGE_SIZE, NOW);
      expect(page.keys).toEqual(["zzz-ready"]);
      // Sleeping retries are not deferred work for this pass.
      expect(page.deferred).toBe(0);

      for (let pass = 0; pass < 2; pass++) {
        const queue = fakeQueue();
        const r = await reconcileEvents({
          events: pgEventStore(sql),
          queue,
          lock: memLock(),
          now: () => NOW,
        });
        expect(queue.sent.map((b) => b.eventKey)).toEqual(["zzz-ready"]);
        expect(r).toMatchObject({ closed: 0, materialized: 0, resynced: 1, deferred: 0 });
      }

      // The pass mutated nothing about the sleeping requests.
      const sleeping = (await sql`select count(*)::int as n from event_sync_attempts
        where state = 'pending' and request_attempts = 1 and next_attempt_at = ${FUTURE}`) as {
        n: number;
      }[];
      expect(sleeping[0]!.n).toBe(total);
    });

    it("dirty revisions parked behind a future pending do not re-enter before the deadline", async () => {
      // Dirty only by revision (mirrored + acknowledged, then edited), with an
      // attempted sleeping retry: re-entry would come through the dirty branch.
      const dirtyId = await seedPublished("aaa-dirty-future");
      await markClean("aaa-dirty-future");
      await sql`update events set sync_revision = sync_revision + 1 where id = ${dirtyId}`;
      await seedAttempt(dirtyId, { attempts: 1, nextAttemptAt: FUTURE });
      // Clean revisions: selectable today only through the recovery branch.
      const recoveryId = await seedPublished("aaa-recovery-future");
      await markClean("aaa-recovery-future");
      await seedAttempt(recoveryId, { attempts: 2, nextAttemptAt: FUTURE });
      // A never-attempted pending snapshot whose first attempt is also future.
      const unattemptedId = await seedPublished("aaa-unattempted-future");
      await seedAttempt(unattemptedId, { attempts: 0, nextAttemptAt: FUTURE });
      await seedPublished("zzz-ready");

      const store = pgEventStore(sql);
      expect(await pageWith(store, 10, NOW)).toEqual({ keys: ["zzz-ready"], deferred: 0 });

      // No-limit / single-key controls keep today's clock-free semantics:
      // every sleeping key is still stale and still reports needsSync.
      expect(await store.staleEventKeys()).toEqual([
        "aaa-dirty-future",
        "aaa-recovery-future",
        "aaa-unattempted-future",
        "zzz-ready",
      ]);
      for (const k of ["aaa-dirty-future", "aaa-recovery-future", "aaa-unattempted-future"])
        expect(await store.needsSync(k)).toBe(true);
      // prepareSync still waits behind the sleeping recovery request instead
      // of minting a competing snapshot.
      expect(
        await store.prepareSync("aaa-recovery-future", "77777777-7777-4777-8777-777777777777", NOW),
      ).toEqual({ waiting: true });

      const queue = fakeQueue();
      const r = await reconcileEvents({
        events: pgEventStore(sql),
        queue,
        lock: memLock(),
        now: () => NOW,
      });
      expect(queue.sent.map((b) => b.eventKey)).toEqual(["zzz-ready"]);
      expect(r).toMatchObject({ resynced: 1, deferred: 0 });
    });

    it("a cutoff without a page limit returns only due keys, not sleeping recovery or dirty keys", async () => {
      const recoveryId = await seedPublished("aaa-recovery-future");
      await markClean("aaa-recovery-future");
      await seedAttempt(recoveryId, { attempts: 2, nextAttemptAt: FUTURE });
      const dirtyId = await seedPublished("aaa-dirty-future");
      await markClean("aaa-dirty-future");
      await sql`update events set sync_revision = sync_revision + 1 where id = ${dirtyId}`;
      await seedAttempt(dirtyId, { attempts: 0, nextAttemptAt: FUTURE });
      // Insert eligible keys out of event-key order. The unbounded cutoff read
      // must filter sleeping candidates and still return its due keys sorted.
      await seedPublished("zzz-ready");
      await seedPublished("bbb-ready");

      const store = pgEventStore(sql);
      expect(await store.staleEventKeys(undefined, NOW)).toEqual(["bbb-ready", "zzz-ready"]);
      expect(await store.staleEventKeys()).toEqual([
        "aaa-dirty-future",
        "aaa-recovery-future",
        "bbb-ready",
        "zzz-ready",
      ]);
    });

    it("an attempts-0 dirty request is due at the exact deadline, but its future twin is not", async () => {
      const original = "99999999-9999-4999-8999-999999999999";
      const dueId = await seedPublished("aaa-dirty-due");
      await markClean("aaa-dirty-due");
      await sql`update events set sync_revision = sync_revision + 1 where id = ${dueId}`;
      await seedAttempt(dueId, { attempts: 0, nextAttemptAt: NOW, idempotencyKey: original });
      const earlyId = await seedPublished("aaa-dirty-early");
      await markClean("aaa-dirty-early");
      await sql`update events set sync_revision = sync_revision + 1 where id = ${earlyId}`;
      const future = new Date(NOW.getTime() + 1000);
      await seedAttempt(earlyId, { attempts: 0, nextAttemptAt: future });

      const store = pgEventStore(sql);
      // Neither row can enter through recovery, which requires attempts > 0.
      expect(await pageWith(store, 10, new Date(NOW.getTime() - 1000))).toEqual({
        keys: [],
        deferred: 0,
      });
      expect(await pageWith(store, 10, NOW)).toEqual({ keys: ["aaa-dirty-due"], deferred: 0 });

      const queue = fakeQueue();
      const r = await reconcileEvents({ events: store, queue, lock: memLock(), now: () => NOW });
      expect(queue.sent).toEqual([
        expect.objectContaining({ eventKey: "aaa-dirty-due", idempotencyKey: original }),
      ]);
      expect(r).toMatchObject({ resynced: 1, deferred: 0 });
      expect(await store.pendingSync("aaa-dirty-due")).toMatchObject({
        idempotencyKey: original,
        requestAttempts: 0,
        nextAttemptAt: NOW,
      });
      expect(await store.pendingSync("aaa-dirty-early")).toMatchObject({
        requestAttempts: 0,
        nextAttemptAt: future,
      });
    });

    it("the exact deadline is due under the original key; one second earlier is not", async () => {
      const original = "88888888-8888-4888-8888-888888888888";
      const dueId = await seedPublished("mmm-due");
      await markClean("mmm-due");
      await seedAttempt(dueId, { attempts: 2, nextAttemptAt: NOW, idempotencyKey: original });
      const earlyId = await seedPublished("mmm-early");
      await markClean("mmm-early");
      await seedAttempt(earlyId, {
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() + 1000),
      });

      const store = pgEventStore(sql);
      expect(await pageWith(store, 10, new Date(NOW.getTime() - 1000))).toEqual({
        keys: [],
        deferred: 0,
      });
      expect(await pageWith(store, 10, NOW)).toEqual({ keys: ["mmm-due"], deferred: 0 });

      const queue = fakeQueue();
      const r = await reconcileEvents({
        events: pgEventStore(sql),
        queue,
        lock: memLock(),
        now: () => NOW,
      });
      expect(queue.sent).toEqual([
        expect.objectContaining({ eventKey: "mmm-due", idempotencyKey: original }),
      ]);
      expect(r).toMatchObject({ resynced: 1, deferred: 0 });

      // Dispatch alone never rewrites the durable request identity.
      const pending = await store.pendingSync("mmm-due");
      expect(pending).toMatchObject({ idempotencyKey: original, requestAttempts: 2 });
    });

    it("the supplied cutoff, not the database wall clock, decides due eligibility", async () => {
      // Deadline after the test database's wall clock (the suite runs in
      // October 2026) but before a supplied 2027 cutoff: selectable only if
      // the selection honours the supplied clock.
      const lateId = await seedPublished("nnn-late");
      await markClean("nnn-late");
      await seedAttempt(lateId, {
        attempts: 1,
        nextAttemptAt: new Date("2026-12-01T00:00:00Z"),
      });

      const store = pgEventStore(sql);
      expect(await pageWith(store, 10, NOW)).toEqual({ keys: [], deferred: 0 });
      expect(await pageWith(store, 10, new Date("2027-01-01T00:00:00Z"))).toEqual({
        keys: ["nnn-late"],
        deferred: 0,
      });
    });

    it("page bounds and deferred count only the due-eligible remainder, in key order", async () => {
      for (let i = 0; i < 3; i++) {
        const id = await seedPublished(`aaa-future-${i}`);
        await seedAttempt(id, { attempts: 1, nextAttemptAt: FUTURE });
      }
      // Inserted in reverse: order must come from the selection.
      for (let i = 4; i >= 0; i--) await seedPublished(`zzz-ready-${i}`);
      const ready = [0, 1, 2, 3, 4].map((i) => `zzz-ready-${i}`);

      const store = pgEventStore(sql);
      expect(await pageWith(store, 2, NOW)).toEqual({ keys: ready.slice(0, 2), deferred: 3 });
      expect(await pageWith(store, RECONCILE_REDISPATCH_PAGE_SIZE, NOW)).toEqual({
        keys: ready,
        deferred: 0,
      });

      // Control: without a cutoff the page keeps today's clock-free set.
      expect(await pageWith(store, RECONCILE_REDISPATCH_PAGE_SIZE)).toEqual({
        keys: ["aaa-future-0", "aaa-future-1", "aaa-future-2", ...ready],
        deferred: 0,
      });
    });

    it("control: exhausted and null-deadline exclusions and terminal intent survive a cutoff pass", async () => {
      const exhaustedId = await seedPublished("aaa-exhausted");
      await seedAttempt(exhaustedId, {
        attempts: SYNC_EVENT.tries,
        nextAttemptAt: PAST, // due by the clock, spent by budget
      });
      const nullId = await seedPublished("aaa-null-deadline");
      await seedAttempt(nullId, {
        attempts: 1,
        nextAttemptAt: null,
        terminalReason: "definitive refusal recorded",
      });
      await seedPublished("zzz-ready");

      const store = pgEventStore(sql);
      expect(await pageWith(store, 10, NOW)).toEqual({ keys: ["zzz-ready"], deferred: 0 });

      const queue = fakeQueue();
      const r = await reconcileEvents({
        events: pgEventStore(sql),
        queue,
        lock: memLock(),
        now: () => NOW,
      });
      expect(queue.sent.map((b) => b.eventKey)).toEqual(["zzz-ready"]);
      expect(r).toMatchObject({ resynced: 1, deferred: 0 });

      const rows = (await sql`select state, terminal_reason from event_sync_attempts
        where event_id = ${nullId}`) as { state: string; terminal_reason: string | null }[];
      expect(rows).toEqual([{ state: "pending", terminal_reason: "definitive refusal recorded" }]);
    });
  },
);
