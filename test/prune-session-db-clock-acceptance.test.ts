// Acceptance oracle: the scheduled web_sessions expiry sweep answers the
// database clock, mirroring the audit-table guard in pgPruneStores. A row is
// eligible only when it is expired by BOTH clocks: `expires_at <= caller now`
// (the existing read-visibility predicate, expiry-exact rows go) AND expired
// by the database's own clock at statement time. A caller clock running
// ahead of the database therefore skips the rows in between — still live by
// the database clock — instead of over-deleting them, and never raises.
//
// Mutations this file must kill:
// - dropping the database-clock predicate (caller-ahead sweeps delete the
//   skew-window rows: counts and survivors below change);
// - replacing the caller predicate with the database clock alone (a
//   caller-behind sweep would delete rows the caller still counts live);
// - weakening the caller predicate to `<` (the expiry-exact row survives);
// - applying the batch LIMIT before the database-clock predicate (skew rows
//   sort first in the bound test, so the first statement comes back short);
// - adding the database-clock guard or a batch bound to the general
//   (non-scheduled) session store, whose full-drain caller-clock contract
//   the control tests pin unchanged.
//
// Memory controls always run; live round-trips use a guarded disposable
// schema on agent-testdb or the explicitly allowed GitHub CI Postgres
// service. All live seeds are placed relative to a database-clock reading
// taken inside the fixture, never the worker clock, so host skew between
// this process and the database cannot move a row across a boundary.
import { describe, expect, it, vi } from "vitest";
import { PRUNE_DELETE_BATCH_SIZE } from "../src/jobs/constants";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores } from "../src/jobs/postgres";
import { createMemorySessionStore, createPostgresSessionStore, type Sql } from "../src/sessions";
import { createJobsFixture } from "./helpers/jobs-db";

const SECOND = 1000;
// Skew geometry, all relative to one database-clock reading: the skew row
// expires 120s after database-now but 180s before the caller-ahead now, so
// only the database-clock predicate can save it. Margins dwarf the few
// statements each test runs after seeding.
const EXPIRED = -120 * SECOND;
const SKEW = 120 * SECOND;
const CALLER_AHEAD = 300 * SECOND;
const LIVE = 3600 * SECOND;

function memoryRow(tokenHash: string, expiresAt: number) {
  return {
    tokenHash,
    userId: "42",
    username: "r",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(expiresAt),
  };
}

describe("non-scheduled sweepExpired contract (memory store, no DB)", () => {
  it("deletes expired and expiry-exact rows by the caller clock, keeps live rows", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const store = createMemorySessionStore(() => now.getTime());
    await store.create(memoryRow("mem-old", now.getTime() - SECOND));
    await store.create(memoryRow("mem-edge", now.getTime()));
    await store.create(memoryRow("mem-live", now.getTime() + LIVE));
    expect(await store.sweepExpired(now)).toBe(2);
    expect(await store.sweepExpired(now)).toBe(0);
    expect(await store.get("mem-live")).not.toBeNull();
  });

  it("drains more than one prune batch in a single call (no scheduled bound)", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const store = createMemorySessionStore(() => now.getTime());
    for (let i = 0; i < PRUNE_DELETE_BATCH_SIZE + 3; i++) {
      await store.create(memoryRow(`mem-bulk-${i}`, now.getTime() - SECOND));
    }
    await store.create(memoryRow("mem-live", now.getTime() + LIVE));
    expect(await store.sweepExpired(now)).toBe(PRUNE_DELETE_BATCH_SIZE + 3);
    expect(await store.sweepExpired(now)).toBe(0);
    expect(await store.get("mem-live")).not.toBeNull();
  });
});

type Fixture = Awaited<ReturnType<typeof createJobsFixture>>;

async function dbNow(fixture: Fixture): Promise<Date> {
  const [row] = await fixture.client<{ now: Date }[]>`select clock_timestamp() as now`;
  return row!.now;
}

async function survivors(fixture: Fixture): Promise<string[]> {
  return (
    await fixture.client<{ token_hash: string }[]>`select token_hash from web_sessions
      order by token_hash`
  ).map((r) => r.token_hash);
}

async function seedSession(fixture: Fixture, tokenHash: string, expiresAt: Date) {
  await fixture.client`insert into web_sessions
    (token_hash, user_id, username, member, moderator, expires_at)
    values (${tokenHash}, '1', 'a', true, false, ${expiresAt})`;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>) {
  const fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
  try {
    const { migrate } = await import("../src/sessions");
    await migrate(fixture.client as unknown as Parameters<typeof migrate>[0]);
    await fn(fixture);
  } finally {
    await fixture.dispose();
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  "scheduled session sweep database clock (test Postgres)",
  () => {
    it("caller clock ahead of the database skips skew-window rows, never over-deletes", async () => {
      await withFixture(async (fixture) => {
        const base = await dbNow(fixture);
        const at = (offset: number) => new Date(base.getTime() + offset);
        await seedSession(fixture, "dbclock-expired", at(EXPIRED));
        await seedSession(fixture, "dbclock-skew", at(SKEW));
        await seedSession(fixture, "dbclock-live", at(LIVE));

        const stores = pgPruneStores(fixture.client);
        // Only the row expired by both clocks goes; the skew-window row is
        // expired by the caller clock alone and must survive untouched.
        expect(await stores.sessions.sweepExpired(at(CALLER_AHEAD))).toBe(1);
        expect(await survivors(fixture)).toEqual(["dbclock-live", "dbclock-skew"]);
        // Skipping is stable: a re-run at the same caller clock is a no-op.
        expect(await stores.sessions.sweepExpired(at(CALLER_AHEAD))).toBe(0);
        expect(await survivors(fixture)).toEqual(["dbclock-live", "dbclock-skew"]);
      });
    });

    it("one scheduled pass with a caller-ahead clock reports exact counts and skips skew rows", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        await withFixture(async (fixture) => {
          const base = await dbNow(fixture);
          const at = (offset: number) => new Date(base.getTime() + offset);
          await seedSession(fixture, "pass-expired", at(EXPIRED));
          await seedSession(fixture, "pass-skew", at(SKEW));
          await seedSession(fixture, "pass-live", at(LIVE));

          const counts = await pruneModelTables(pgPruneStores(fixture.client), at(CALLER_AHEAD));
          expect(counts).toEqual({
            agentEventAudits: 0,
            accessLog: 0,
            joinAttempts: 0,
            idempotencyKeys: 0,
            searchLog: 0,
            boardViews: 0,
            reminderDeliveries: 0,
            sessions: 1,
            jobUniqueLocks: 0,
          });
          expect(await survivors(fixture)).toEqual(["pass-live", "pass-skew"]);
          expect(warn).not.toHaveBeenCalled();
          expect(error).not.toHaveBeenCalled();

          const rerun = await pruneModelTables(pgPruneStores(fixture.client), at(CALLER_AHEAD));
          expect(rerun.sessions).toBe(0);
          expect(await survivors(fixture)).toEqual(["pass-live", "pass-skew"]);
        });
      } finally {
        warn.mockRestore();
        error.mockRestore();
        info.mockRestore();
      }
    });

    it("batch bound is unchanged under a caller-ahead clock and skew rows never block the batch", async () => {
      await withFixture(async (fixture) => {
        const base = await dbNow(fixture);
        const at = (offset: number) => new Date(base.getTime() + offset);
        // Skew rows sort first by token_hash: a statement that limits before
        // applying the database-clock predicate returns a short first batch
        // (or wedges on them) instead of a full one.
        for (let i = 1; i <= 3; i++) {
          await seedSession(fixture, `aa-skew-${i}`, at(SKEW));
        }
        const expired = PRUNE_DELETE_BATCH_SIZE + 3;
        await fixture.client`insert into web_sessions
          (token_hash, user_id, username, member, moderator, expires_at)
          select 'zz-old-' || g, '1', 'a', true, false, ${at(EXPIRED)}
          from generate_series(1, ${expired}) g`;

        const stores = pgPruneStores(fixture.client);
        expect(await stores.sessions.sweepExpired(at(CALLER_AHEAD))).toBe(PRUNE_DELETE_BATCH_SIZE);
        expect(await stores.sessions.sweepExpired(at(CALLER_AHEAD))).toBe(3);
        expect(await stores.sessions.sweepExpired(at(CALLER_AHEAD))).toBe(0);
        expect(await survivors(fixture)).toEqual(["aa-skew-1", "aa-skew-2", "aa-skew-3"]);
      });
    });

    it("caller-behind sweeps stay caller-bounded and the expiry-exact row still goes", async () => {
      await withFixture(async (fixture) => {
        const base = await dbNow(fixture);
        const at = (offset: number) => new Date(base.getTime() + offset);
        const exact = at(-150 * SECOND);
        await seedSession(fixture, "behind-both-expired", at(-300 * SECOND));
        await seedSession(fixture, "behind-exact", exact);
        // Expired by the database clock, still live by both caller clocks
        // below: the caller predicate must keep it (AND semantics, matching
        // the audit guard), so a database-clock-only sweep fails here.
        await seedSession(fixture, "behind-caller-live", at(-60 * SECOND));
        await seedSession(fixture, "behind-live", at(LIVE));

        const stores = pgPruneStores(fixture.client);
        expect(await stores.sessions.sweepExpired(at(-240 * SECOND))).toBe(1);
        expect(await survivors(fixture)).toEqual([
          "behind-caller-live",
          "behind-exact",
          "behind-live",
        ]);
        // Expiry-exact against the caller clock keeps the existing `<=`
        // contract (reads already cannot see the row) under the new guard.
        expect(await stores.sessions.sweepExpired(exact)).toBe(1);
        expect(await survivors(fixture)).toEqual(["behind-caller-live", "behind-live"]);
      });
    });

    it("non-scheduled Postgres store keeps its full-drain caller-clock contract", async () => {
      await withFixture(async (fixture) => {
        const base = await dbNow(fixture);
        const at = (offset: number) => new Date(base.getTime() + offset);
        const bulk = PRUNE_DELETE_BATCH_SIZE + 1;
        await fixture.client`insert into web_sessions
          (token_hash, user_id, username, member, moderator, expires_at)
          select 'general-old-' || g, '1', 'a', true, false, ${at(EXPIRED)}
          from generate_series(1, ${bulk}) g`;
        // The skew-window row the scheduled sweep must skip is swept here:
        // the general store answers the caller clock alone, in one call,
        // with no batch bound. Guarding or bounding it fails this test.
        await seedSession(fixture, "general-skew", at(SKEW));
        await seedSession(fixture, "general-live", at(LIVE));

        const store = createPostgresSessionStore(fixture.client as unknown as Sql);
        expect(await store.sweepExpired(at(CALLER_AHEAD))).toBe(bulk + 1);
        expect(await store.sweepExpired(at(CALLER_AHEAD))).toBe(0);
        expect(await survivors(fixture)).toEqual(["general-live"]);
      });
    });
  },
);
