import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgPruneStores, pgQueueLedger, pgSingleFlight, pgUniqueLock } from "../src/jobs/postgres";

// Real Postgres (agent-testdb locally, a service container in CI). Skipped when DATABASE_URL is unset.
// Only run-owned tables are created (`job_unique_locks` is created by the
// canonical migrations, not by this suite); keys are unique per run, and the
// suite deletes only its own rows. Never touches caller tables.
describe.skipIf(!process.env.DATABASE_URL)("postgres single-flight + unique lock", () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 4 });
  const owned: string[] = [];
  const own = (prefix: string) => {
    const k = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    owned.push(k);
    return k;
  };
  beforeAll(async () => {
    await sql`create table if not exists job_unique_locks (key text primary key, expires_at timestamptz not null)`;
  });
  afterAll(async () => {
    if (owned.length) await sql`delete from job_unique_locks where key = any(${owned})`;
    await sql.end({ timeout: 1 });
  });

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

  it("flight body queries run on the reserved tx (no max:1 deadlock)", async () => {
    // Production shape: one connection, flight holding it in a transaction.
    // A body query on the outer pool would queue for that connection forever;
    // bodies must run on the client the flight hands them. Times out instead
    // of hanging the suite if the deadlock regresses. Self-sufficient tables:
    // neither member_data_access_logs nor web_sessions can be assumed present
    // (CI migrates the drizzle chain, but web_sessions is runtime-DDL-only).
    const schema = `flight_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    await admin.unsafe(`CREATE TABLE ${schema}.member_data_access_logs (id bigserial primary key, occurred_at timestamptz not null)`);
    await admin.unsafe(`CREATE TABLE ${schema}.job_unique_locks (key text primary key, expires_at timestamptz not null)`);
    const { migrate } = await import("../src/sessions");
    const one = postgres(process.env.DATABASE_URL!, { max: 1, connection: { search_path: schema } });
    try {
      await migrate(one as unknown as Parameters<typeof migrate>[0]);
      const ledgerMigration = readFileSync("drizzle/1007_queue-ledger.sql", "utf8");
      for (const statement of ledgerMigration.split("--> statement-breakpoint")) {
        if (statement.trim()) await one.unsafe(statement);
      }
      const flight = pgSingleFlight(one);
      const ran = await Promise.race([
        flight(`prune-${Date.now()}`, async (db) => {
          const stores = pgPruneStores(db);
          const lock = pgUniqueLock(db);
          expect(await stores.accessLog.pruneOlderThan(new Date(0))).toBeGreaterThanOrEqual(0);
          expect(await stores.sessions.sweepExpired(new Date())).toBeGreaterThanOrEqual(0);
          expect(await lock.acquire(`prune-tx-${Date.now()}`, 60)).toBe(true);
          // Reconcile's tracking queue must also use this reserved connection.
          const ledger = pgQueueLedger(db as postgres.TransactionSql);
          const jobId = randomUUID();
          await ledger.enqueued({ jobId, kind: "sync-event", key: "tx", availableAt: new Date() });
          const tx = db as postgres.TransactionSql;
          expect(await tx`select job_id from queue_jobs where job_id = ${jobId}::uuid`).toHaveLength(1);
          await ledger.failed(jobId, "sync-event", "tx", "test failure");
          expect(await tx`select job_id from queue_jobs where job_id = ${jobId}::uuid`).toHaveLength(0);
          expect(await tx`select job_id from queue_failed_jobs where job_id = ${jobId}::uuid`).toHaveLength(1);
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("deadlock: body stalled on max:1 pool")), 15_000)),
      ]);
      expect(ran).toBe(true);
    } finally {
      await one.end({ timeout: 5 });
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
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
});
