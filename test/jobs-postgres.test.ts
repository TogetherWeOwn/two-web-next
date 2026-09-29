import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgSingleFlight, pgUniqueLock } from "../src/jobs/postgres";

// Real Postgres (agent-testdb locally, a service container in CI). Skipped when DATABASE_URL is unset.
describe.skipIf(!process.env.DATABASE_URL)("postgres single-flight + unique lock", () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 4 });
  beforeAll(async () => {
    await sql`create table if not exists job_unique_locks (key text primary key, expires_at timestamptz not null)`;
  });
  afterAll(() => sql.end({ timeout: 1 }));

  it("overlapping cron invocations single-flight, and the lock frees afterwards", async () => {
    const name = `test-flight-${Date.now()}`;
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
    const a = flight(`a-${Date.now()}`, () => gate);
    await new Promise((r) => setTimeout(r, 100));
    expect(await flight(`b-${Date.now()}`, async () => {})).toBe(true);
    release();
    await a;
  });

  it("unique lock: one winner, expiry frees it, release frees it", async () => {
    const lock = pgUniqueLock(sql);
    const key = `k-${Date.now()}`;
    const wins = await Promise.all([1, 2, 3, 4].map(() => lock.acquire(key, 300)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    await sql`update job_unique_locks set expires_at = now() - interval '1 second' where key = ${key}`;
    expect(await lock.acquire(key, 300)).toBe(true); // expired row is taken over
    await lock.release(key);
    expect(await lock.acquire(key, 300)).toBe(true);
    await lock.release(key);
  });
});
