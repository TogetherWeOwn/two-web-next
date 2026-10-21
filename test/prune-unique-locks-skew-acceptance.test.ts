// Acceptance oracle: the scheduled job_unique_locks expiry sweep answers the
// database clock, mirroring the web_sessions guard in pgPruneStores. A row is
// eligible only when it is expired by BOTH clocks: `expires_at <= caller now`
// AND `expires_at <= clock_timestamp()` in the candidate subquery and the
// outer DELETE. A caller clock running ahead therefore skips a live lease the
// caller alone calls expired, instead of deleting a lease acquire (which
// answers the database clock) still honors. A caller clock running behind
// stays caller-bounded: a database-expired row the caller still counts live
// survives.
//
// Mutations this file must kill:
// - dropping the database-clock predicate (caller-ahead sweep deletes the
//   skew-window lease: counts, survivors and reacquire below change);
// - replacing the caller predicate with the database clock alone (a
//   caller-behind sweep deletes the row the caller still counts live).
//
// Memory fakes cannot pin this: expiry is a database-clock predicate. Live
// round-trips use a guarded disposable schema on agent-testdb or the
// explicitly allowed GitHub CI Postgres service. All seeds and caller clocks
// are placed relative to a database-clock reading taken inside the fixture,
// never the worker clock.
import { describe, expect, it } from "vitest";
import { pgPruneStores, pgUniqueLock } from "../src/jobs/postgres";
import { createJobsFixture } from "./helpers/jobs-db";

const SECOND = 1000;
// Skew geometry, all relative to one database-clock reading. The caller-ahead
// lease holds 30s by the database clock while the caller clock sits 120s past
// its database expiry, so only the database-clock predicate can save it. The
// caller-behind row expires 60s before database-now but 60s after the behind
// caller clock, so only the caller predicate can save it. Margins dwarf the
// few statements each test runs after seeding.
const LEASE_TTL_SECONDS = 30;
const CALLER_AHEAD_PAST_EXPIRY = 120 * SECOND;
const BOTH_EXPIRED = -120 * SECOND;
const BEHIND_BOTH_EXPIRED = -300 * SECOND;
const BEHIND_CALLER_LIVE = -60 * SECOND;
const BEHIND_CALLER_NOW = -120 * SECOND;
const LIVE = 3600 * SECOND;

type Fixture = Awaited<ReturnType<typeof createJobsFixture>>;

async function dbNow(fixture: Fixture): Promise<Date> {
  const [row] = await fixture.client<{ now: Date }[]>`select clock_timestamp() as now`;
  return row!.now;
}

async function lockKeys(fixture: Fixture): Promise<string[]> {
  return (
    await fixture.client<{ key: string }[]>`select key from job_unique_locks order by key`
  ).map((r) => r.key);
}

async function seedLock(fixture: Fixture, key: string, expiresAt: Date) {
  await fixture.client`insert into job_unique_locks (key, expires_at)
    values (${key}, ${expiresAt})`;
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
  "scheduled unique-lock sweep database clock (test Postgres)",
  () => {
    it("caller clock ahead of the database skips a live lease, deletes only both-expired rows", async () => {
      await withFixture(async (fixture) => {
        const base = await dbNow(fixture);
        const lock = pgUniqueLock(fixture.client);
        const skewKey = "skew-caller-ahead-live";
        const controlKey = "skew-caller-ahead-expired";

        const token = await lock.acquire(skewKey, LEASE_TTL_SECONDS);
        expect(token).toEqual(expect.any(String));
        expect(await lock.acquire(skewKey, LEASE_TTL_SECONDS)).toBeNull();

        const [lease] = await fixture.client<{ expires_at: Date }[]>`
          select expires_at from job_unique_locks where key = ${skewKey}`;
        const expiresAt = lease!.expires_at;
        // Sanity-pin the geometry: the lease is live by the database clock
        // with a full TTL of margin, so the test cannot flake on timing.
        expect(expiresAt.getTime() - base.getTime()).toBeGreaterThan(25 * SECOND);
        expect(expiresAt.getTime() - base.getTime()).toBeLessThan(35 * SECOND);

        await seedLock(fixture, controlKey, new Date(base.getTime() + BOTH_EXPIRED));

        const callerAhead = new Date(expiresAt.getTime() + CALLER_AHEAD_PAST_EXPIRY);
        const stores = pgPruneStores(fixture.client);
        // Only the row expired by both clocks goes; the skew-window lease is
        // expired by the caller clock alone and must survive untouched.
        expect(await stores.jobUniqueLocks!.sweepExpired(callerAhead)).toBe(1);
        expect(await lockKeys(fixture)).toEqual([skewKey]);
        // The surviving lease still blocks a second acquire.
        expect(await lock.acquire(skewKey, LEASE_TTL_SECONDS)).toBeNull();
        // Skipping is stable: a re-run at the same caller clock is a no-op.
        expect(await stores.jobUniqueLocks!.sweepExpired(callerAhead)).toBe(0);
        expect(await lockKeys(fixture)).toEqual([skewKey]);
        // The control row is really gone: its key is immediately reusable.
        expect(await lock.acquire(controlKey, LEASE_TTL_SECONDS)).toEqual(expect.any(String));
      });
    });

    it("caller-behind sweep keeps a database-expired row the caller still counts live", async () => {
      await withFixture(async (fixture) => {
        const base = await dbNow(fixture);
        const at = (offset: number) => new Date(base.getTime() + offset);
        await seedLock(fixture, "behind-both-expired", at(BEHIND_BOTH_EXPIRED));
        await seedLock(fixture, "behind-caller-live", at(BEHIND_CALLER_LIVE));
        await seedLock(fixture, "behind-live", at(LIVE));

        const stores = pgPruneStores(fixture.client);
        // Only the row expired by both clocks goes; the database-expired row
        // the behind caller still counts live must survive (AND semantics).
        expect(await stores.jobUniqueLocks!.sweepExpired(at(BEHIND_CALLER_NOW))).toBe(1);
        expect(await lockKeys(fixture)).toEqual(["behind-caller-live", "behind-live"]);
        expect(await stores.jobUniqueLocks!.sweepExpired(at(BEHIND_CALLER_NOW))).toBe(0);
        expect(await lockKeys(fixture)).toEqual(["behind-caller-live", "behind-live"]);

        // The caller-live row is real: once the caller clock also passes its
        // expiry, the same sweeper removes it and leaves only the live lease.
        expect(await stores.jobUniqueLocks!.sweepExpired(at(-BEHIND_CALLER_LIVE))).toBe(1);
        expect(await lockKeys(fixture)).toEqual(["behind-live"]);
      });
    });
  },
);
