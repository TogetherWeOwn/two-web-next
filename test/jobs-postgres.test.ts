import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgPruneStores, pgSingleFlight, pgUniqueLock } from "../src/jobs/postgres";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

// Real Postgres, guarded before driver construction: agent-testdb or the CI
// service only. Each fixture migrates and drops only its disposable schema.
describe.skipIf(!process.env.DATABASE_URL)("postgres single-flight + unique lock", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;
  const own = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
  });
  afterAll(async () => { await fixture?.dispose(); });

  it("overlapping cron invocations single-flight, and the lock frees afterwards", async () => {
    const name = own("test-flight");
    const flight = pgSingleFlight(sql);
    let running = 0, maxRunning = 0, runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = async () => {
      running++; maxRunning = Math.max(maxRunning, running); runs++;
      await gate;
      running--;
    };
    const first = flight(name, job);
    await new Promise((r) => setTimeout(r, 200)); // first now holds the lock
    const second = await flight(name, job); // overlaps: must skip
    release();
    expect(await first).toBe(true);
    expect(second).toBe(false);
    expect(runs).toBe(1);
    expect(maxRunning).toBe(1);
    expect(await flight(name, async () => {})).toBe(true); // released after commit
  });

  it("different jobs do not block each other", async () => {
    const flight = pgSingleFlight(sql);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = flight(own("a"), () => gate);
    await new Promise((r) => setTimeout(r, 100));
    expect(await flight(own("b"), async () => {})).toBe(true);
    release();
    await a;
  });

  describe("reserved transaction", () => {
    let single: JobsFixture | undefined;
    beforeAll(async () => {
      // Keep schema/session migration outside the test's deadlock budget.
      single = await createJobsFixture(process.env.DATABASE_URL!, { max: 1 });
      const { migrate } = await import("../src/sessions");
      await migrate(single.client as unknown as Parameters<typeof migrate>[0]);
    });
    afterAll(async () => { await single?.dispose(); });

    it("flight body queries run on the reserved tx (no max:1 deadlock)", async () => {
      // The outer pool has one connection held by the flight; prune queries
      // must use its reserved client. Dispatch uses a separate autocommit pool.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const ran = await Promise.race([
          pgSingleFlight(single!.client)(own("prune"), async (db) => {
            const stores = pgPruneStores(db);
            const lock = pgUniqueLock(db);
            for (const table of [stores.accessLog, stores.joinAttempts, stores.idempotencyKeys, stores.searchLog]) {
              expect(await table.pruneOlderThan(new Date(0))).toBe(0);
            }
            expect(await stores.sessions.sweepExpired(new Date())).toBe(0);
            expect(await lock.acquire(own("prune-tx"), 60)).toBe(true);
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("deadlock: body stalled on max:1 pool")), 3000);
          }),
        ]);
        expect(ran).toBe(true);
      } finally {
        clearTimeout(timeout);
      }
    });
  });

  it("unique lock: one winner, expiry frees it, release frees it", async () => {
    const lock = pgUniqueLock(sql);
    const key = own("k");
    const wins = await Promise.all([1, 2, 3, 4].map(() => lock.acquire(key, 300)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    await sql`update job_unique_locks set expires_at = now() - interval '1 second' where key = ${key}`;
    expect(await lock.acquire(key, 300)).toBe(true); // expired row is taken over
    await lock.release(key);
    expect(await lock.acquire(key, 300)).toBe(true);
    await lock.release(key);
  });

  it("new locks get their full TTL even in an old transaction", async () => {
    await sql.begin(async (tx) => {
      await tx`select pg_sleep(0.2)`;
      const key = own("fresh-ttl");
      expect(await pgUniqueLock(tx).acquire(key, 1)).toBe(true);
      const [row] = await tx`select extract(epoch from expires_at - clock_timestamp())::float as remaining
        from job_unique_locks where key = ${key}`;
      expect(row!.remaining).toBeGreaterThan(0.9);
    });
  });

  it("takes over a lock that expired after the transaction began", async () => {
    const key = own("elapsed-ttl");
    await sql`insert into job_unique_locks (key, expires_at) values (${key}, clock_timestamp() + interval '0.1 second')`;
    await sql.begin(async (tx) => {
      await tx`select pg_sleep(0.2)`;
      expect(await pgUniqueLock(tx).acquire(key, 1)).toBe(true);
      const [row] = await tx`select extract(epoch from expires_at - clock_timestamp())::float as remaining
        from job_unique_locks where key = ${key}`;
      expect(row!.remaining).toBeGreaterThan(0.9);
    });
  });
});
