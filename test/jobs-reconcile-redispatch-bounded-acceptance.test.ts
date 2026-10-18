// Acceptance suite: one reconcile pass redispatches a bounded page of stale
// events, in key order, and logs how many stale rows it deferred.
//
// Locked contract for the builder (this file is acceptance-owned; the builder
// must not edit it):
//
// 1. `src/jobs/constants.ts` exports `RECONCILE_REDISPATCH_PAGE_SIZE = 200`,
//    documented where it is defined.
// 2. `EventStore.staleEventKeys(limit?: number)` resolves
//    `{ keys: string[], deferred: number }`:
//    - `keys` are stale event keys in ascending `event_key` order (the real
//      store does this in SQL: `ORDER BY event_key` + `LIMIT`), at most
//      `limit` of them when a positive limit is passed;
//    - `deferred` is how many stale keys matched but were NOT returned
//      (total stale - keys.length), so it is 0 exactly when the page drained
//      the backlog. A window count in the same statement is one way to get
//      it; the shape is what is pinned, not the SQL spelling.
//    The single-key eligibility path (`needsSync`, `prepareSync`) keeps its
//    current semantics; only the page selection above is new.
// 3. `reconcileEvents` asks the store for exactly one page per pass: it calls
//    `staleEventKeys(RECONCILE_REDISPATCH_PAGE_SIZE)` once, dispatches at most
//    that many keys, in the order the store returned them, and resolves
//    `{ closed, materialized, resynced, absorbed, failed, deferred }` where
//    `resynced` counts only transport-accepted dispatches, `absorbed` counts
//    unique-lock absorptions and `failed` counts throwing keys (the counting
//    semantics already on main, passed through unchanged, page-scoped), and
//    `deferred` is the store's remainder. Keys deferred by a pass stay
//    stale: nothing in the pass marks, skips or reorders them, so the next
//    pass picks them up once earlier keys have synced.
// 4. Logging volume is unchanged: at most the one existing
//    "Event reconcile pass completed." info line per pass, now carrying
//    `deferred` next to the other counts, and emitted when any of
//    closed/materialized/resynced/absorbed/failed/deferred is non-zero (a
//    pass that only deferred must still be visible). No per-key log lines.
// 5. Pass cadence, dispatch semantics (unique lock, pending recovery,
//    close-before-sync ordering) and retention are unchanged.
//
// Hermetic fakes below return a dual-shaped page (an array that also carries
// `keys`/`deferred`) so the positive controls run against today's array
// return and still run once the builder lands the `{keys, deferred}` shape.
// Controls assert with `toMatchObject`/`objectContaining` for the same
// reason: they pin behaviour that exists today and must survive.
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as jobConstants from "../src/jobs/constants";
import { reconcileEvents } from "../src/jobs/cron";
import { pgEventStore } from "../src/jobs/events";
import { uniqueKey } from "../src/jobs/sync-event";
import type { EventStore, UniqueLock } from "../src/jobs/types";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const EXPECTED_PAGE_SIZE = 200;
const pageSizeExport = (jobConstants as Record<string, unknown>).RECONCILE_REDISPATCH_PAGE_SIZE;

const keyAt = (i: number) => `ev-${String(i).padStart(3, "0")}`;
const keysUpTo = (n: number) => Array.from({ length: n }, (_, i) => keyAt(i));

type Page = string[] & { keys: string[]; deferred: number };
const dualPage = (keys: string[], deferred: number): Page =>
  Object.assign([...keys], { keys: [...keys], deferred });

/**
 * Stateful in-memory store. `stale` holds the not-yet-synced keys in
 * insertion order; like the real store under the new contract, a page
 * request with an explicit limit answers in ascending key order and reports
 * the deferred remainder. Without a limit it answers everything, as today's
 * store does.
 */
function fakeEvents(stale: string[]) {
  const pending = new Set(stale);
  const calls: string[] = [];
  const limits: (number | undefined)[] = [];
  const store = {
    calls,
    limits,
    staleLeft: () => [...pending].sort(),
    markClean: (keys: string[]) => keys.forEach((k) => pending.delete(k)),
    prepareSync: async () => null,
    completeSync: async () => {},
    claimSync: async () => null,
    deferSync: async () => {},
    failSync: async () => {},
    needsSync: async (k: string) => pending.has(k),
    pendingSync: async () => null,
    closeFinished: async () => (calls.push("close"), 0),
    materializeSeries: async () => (calls.push("materialize"), 0),
    staleEventKeys: async (limit?: number) => {
      calls.push("stale");
      limits.push(limit);
      if (limit === undefined) return dualPage([...pending], 0);
      const sorted = [...pending].sort();
      return dualPage(sorted.slice(0, limit), Math.max(0, sorted.length - limit));
    },
  };
  return store as typeof store & EventStore;
}

function fakeQueue() {
  const sent: string[] = [];
  return {
    sent,
    send: async (body: unknown) => void sent.push((body as { eventKey: string }).eventKey),
  };
}

function fakeLock(held: string[] = []): UniqueLock {
  const locked = new Set(held);
  return {
    acquire: async (k) => (locked.has(k) ? null : (locked.add(k), crypto.randomUUID())),
    release: async (k) => void locked.delete(k),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("reconcile redispatch bound — positive controls (today's behaviour)", () => {
  it("dispatches every stale key of an under-page pass and counts the lock-absorbed row as absorbed", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const events = fakeEvents(["alpha", "beta", "gamma"]);
    const queue = fakeQueue();

    const r = await reconcileEvents({
      events,
      queue,
      lock: fakeLock([uniqueKey("beta")]),
    });

    expect(queue.sent).toEqual(["alpha", "gamma"]);
    expect(r).toMatchObject({ closed: 0, materialized: 0, resynced: 2, absorbed: 1 });
    expect(events.calls).toEqual(["close", "materialize", "stale"]);
  });

  it("an empty pass sends nothing and logs nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const queue = fakeQueue();

    const r = await reconcileEvents({ events: fakeEvents([]), queue, lock: fakeLock() });

    expect(r).toMatchObject({ closed: 0, materialized: 0, resynced: 0 });
    expect(queue.sent).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it("a non-empty under-page pass logs exactly one completion line with its counts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await reconcileEvents({
      events: fakeEvents(["only"]),
      queue: fakeQueue(),
      lock: fakeLock(),
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "Event reconcile pass completed.",
      expect.objectContaining({ closed: 0, materialized: 0, resynced: 1 }),
    );
  });
});

describe("reconcile redispatch bound — new behaviour", () => {
  it("exports the documented page size constant", () => {
    expect(pageSizeExport).toBe(EXPECTED_PAGE_SIZE);
  });

  it("one pass over a >page backlog dispatches exactly one page in key order and logs the remainder", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const total = EXPECTED_PAGE_SIZE + 5;
    // Insertion order is reversed: key order must come from the selection,
    // not from the order rows happened to be stored in.
    const events = fakeEvents(keysUpTo(total).reverse());
    const queue = fakeQueue();

    const r = await reconcileEvents({ events, queue, lock: fakeLock() });

    expect(events.limits).toEqual([EXPECTED_PAGE_SIZE]);
    expect(queue.sent).toEqual(keysUpTo(EXPECTED_PAGE_SIZE));
    expect(r).toMatchObject({
      closed: 0,
      materialized: 0,
      resynced: EXPECTED_PAGE_SIZE,
      deferred: 5,
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "Event reconcile pass completed.",
      expect.objectContaining({ resynced: EXPECTED_PAGE_SIZE, deferred: 5 }),
    );
    // The remainder was neither dispatched nor consumed: it is still stale.
    expect(events.staleLeft()).toEqual(keysUpTo(total));
    expect(queue.sent).not.toContain(keyAt(total - 1));
  });

  it("the next pass drains the remainder once the first page has synced", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const total = EXPECTED_PAGE_SIZE + 5;
    const events = fakeEvents(keysUpTo(total).reverse());
    const queue = fakeQueue();

    await reconcileEvents({ events, queue, lock: fakeLock() });
    // The consumer synced the first page between passes; dispatch alone
    // never clears staleness, so model that explicitly.
    events.markClean(queue.sent);
    queue.sent.length = 0;

    const r = await reconcileEvents({ events, queue, lock: fakeLock() });

    expect(queue.sent).toEqual(keysUpTo(total).slice(EXPECTED_PAGE_SIZE));
    expect(r).toMatchObject({ resynced: 5, deferred: 0 });
  });

  it("a backlog of exactly one page dispatches in full and defers nothing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const events = fakeEvents(keysUpTo(EXPECTED_PAGE_SIZE).reverse());
    const queue = fakeQueue();

    const r = await reconcileEvents({ events, queue, lock: fakeLock() });

    expect(queue.sent).toEqual(keysUpTo(EXPECTED_PAGE_SIZE));
    expect(r).toMatchObject({ resynced: EXPECTED_PAGE_SIZE, deferred: 0 });
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "reconcile redispatch bound — real pg store (agent-testdb)",
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

    const NOW = new Date("2026-10-01T12:00:00Z");
    const LEASE = "22222222-2222-4222-8222-222222222222";
    const memLock = (): UniqueLock => {
      const held = new Set<string>();
      return {
        acquire: async (k) => (held.has(k) ? null : (held.add(k), LEASE)),
        release: async (k, token) => {
          if (token === LEASE) held.delete(k);
        },
      };
    };

    async function seedStale(eventKey: string): Promise<void> {
      await sql`insert into events
        (event_key, title, starts_at, ends_at, timezone, location, status, discord_event_id,
          recurrence_frequency, recurrence_count, parent_event_id, recurrence_index)
      values (${eventKey}, ${`event ${eventKey}`},
        ${new Date("2026-10-01T10:00:00Z")}, ${new Date("2026-10-01T14:00:00Z")},
        'Europe/London', 'hall', 'published', null, null, null, null, null)`;
    }
    // A synced row: mirrored id present (unique per event) and the revision
    // pair acknowledged.
    async function markCleanKeys(keys: string[]): Promise<void> {
      for (const k of keys)
        await sql`update events set discord_event_id = 'discord-' || event_key,
          synced_revision = sync_revision where event_key = ${k}`;
    }
    const pageOf = async (limit: number) =>
      (pgEventStore(sql).staleEventKeys as (limit?: number) => Promise<unknown>)(limit) as Promise<{
        keys: string[];
        deferred: number;
      }>;

    it("the stale selection returns one ordered page with the deferred remainder counted", async () => {
      const stale = ["pg-g", "pg-a", "pg-f", "pg-b", "pg-e", "pg-c", "pg-d"];
      for (const k of stale) await seedStale(k);
      await seedStale("pg-clean");
      await markCleanKeys(["pg-clean"]);

      const page = await pageOf(3);

      expect(page.keys).toEqual(["pg-a", "pg-b", "pg-c"]);
      expect(page.deferred).toBe(4);
    });

    it("successive selections walk the backlog in key order without skipping a row", async () => {
      for (const k of ["walk-d", "walk-a", "walk-g", "walk-b", "walk-f", "walk-c", "walk-e"])
        await seedStale(k);

      const first = await pageOf(3);
      expect(first).toEqual({ keys: ["walk-a", "walk-b", "walk-c"], deferred: 4 });
      await markCleanKeys(first.keys);

      const second = await pageOf(3);
      expect(second).toEqual({ keys: ["walk-d", "walk-e", "walk-f"], deferred: 1 });
      await markCleanKeys(second.keys);

      const third = await pageOf(3);
      expect(third).toEqual({ keys: ["walk-g"], deferred: 0 });
    });

    it("a real pass over a >page backlog sends one page in key order, then the remainder", async () => {
      const total = EXPECTED_PAGE_SIZE + 5;
      await sql`insert into events
        (event_key, title, starts_at, ends_at, timezone, location, status, discord_event_id,
          recurrence_frequency, recurrence_count, parent_event_id, recurrence_index)
      select 'bulk-' || lpad(g::text, 3, '0'), 'event ' || g,
        timestamptz '2026-10-01 10:00:00+00', timestamptz '2026-10-01 14:00:00+00',
        'Europe/London', 'hall', 'published', null, null, null, null, null
      from generate_series(0, ${total - 1}) as g`;
      const bulk = (i: number) => `bulk-${String(i).padStart(3, "0")}`;
      const all = Array.from({ length: total }, (_, i) => bulk(i));

      const sent: string[] = [];
      const queue = {
        send: async (b: unknown) => void sent.push((b as { eventKey: string }).eventKey),
      };
      const first = await reconcileEvents({
        events: pgEventStore(sql),
        queue,
        lock: memLock(),
        now: () => NOW,
      });

      expect(sent).toEqual(all.slice(0, EXPECTED_PAGE_SIZE));
      expect(first).toMatchObject({ resynced: EXPECTED_PAGE_SIZE, deferred: 5 });

      await sql`update events set discord_event_id = 'discord-' || event_key,
        synced_revision = sync_revision where event_key < ${bulk(EXPECTED_PAGE_SIZE)}`;
      sent.length = 0;

      const second = await reconcileEvents({
        events: pgEventStore(sql),
        queue,
        lock: memLock(),
        now: () => NOW,
      });

      expect(sent).toEqual(all.slice(EXPECTED_PAGE_SIZE));
      expect(second).toMatchObject({ resynced: 5, deferred: 0 });
    });
  },
);
