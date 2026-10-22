// Acceptance: the daily model:prune pass sweeps expired job_unique_locks rows.
//
// Today acquire only wins over an expired row for the SAME key and release
// compare-deletes by token, so a key that is never dispatched again leaves its
// expired lock row behind forever. The daily pass must delete expired lock
// rows (and only those), through the same drain/bound discipline as every
// other pruned table, without changing acquire/release semantics.
//
// Contract pinned here (mirrors the web_sessions expiry sweeper):
// - PruneStores gains `jobUniqueLocks: { sweepExpired(now): Promise<number> }`.
// - pruneModelTables drains it at `now` (not a retention cutoff) via the
//   per-statement batch bound and per-table batch cap, warning when capped.
// - PruneCounts gains `jobUniqueLocks` with the exact number of rows removed.
// - pgPruneStores implements it as one batch-bounded statement per call:
//   expired rows go, live leases and unrelated keys survive.
//
// Memory fakes always run; live round-trips use a guarded disposable schema
// on agent-testdb or the explicitly allowed GitHub CI Postgres service.
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PRUNE_DELETE_BATCH_SIZE, PRUNE_DELETE_MAX_BATCHES } from "../src/jobs/constants";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores, pgUniqueLock } from "../src/jobs/postgres";
import type { PruneStores } from "../src/jobs/types";
import { createMemorySessionStore } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

type LockSweeper = { sweepExpired(now: Date): Promise<number> };
type StoresWithLocks = PruneStores & { jobUniqueLocks: LockSweeper };
type CountsWithLocks = Awaited<ReturnType<typeof pruneModelTables>> & {
  jobUniqueLocks: number;
};

function emptyAgeTable() {
  return {
    async pruneOlderThan(_cutoff: Date): Promise<number> {
      return 0;
    },
  };
}

function memStores(now: Date, jobUniqueLocks: LockSweeper): StoresWithLocks {
  return {
    agentEventAudits: emptyAgeTable(),
    accessLog: emptyAgeTable(),
    joinAttempts: emptyAgeTable(),
    idempotencyKeys: emptyAgeTable(),
    searchLog: emptyAgeTable(),
    boardViews: emptyAgeTable(),
    reminderDeliveries: emptyAgeTable(),
    sessions: createMemorySessionStore(() => now.getTime()),
    jobUniqueLocks,
  };
}

/** In-memory lock table implementing the pinned expiry semantics. */
function memLockTable() {
  const rows: { key: string; expiresAt: Date }[] = [];
  const calls: Date[] = [];
  return {
    rows,
    calls,
    async sweepExpired(now: Date): Promise<number> {
      calls.push(now);
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.expiresAt <= now) {
          rows.splice(i, 1);
          n++;
        }
      }
      return n;
    },
  };
}

describe("daily prune sweeps expired unique locks (memory, no DB)", () => {
  it("sweeps at now: expired locks go, live leases survive, count is reported", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const locks = memLockTable();
    locks.rows.push(
      { key: "expired-recent", expiresAt: new Date(now.getTime() - 1000) },
      { key: "expired-ancient", expiresAt: new Date(now.getTime() - 400 * 86_400_000) },
      { key: "live-lease", expiresAt: new Date(now.getTime() + 3600_000) },
    );

    const counts = (await pruneModelTables(memStores(now, locks), now)) as CountsWithLocks;

    expect(counts.jobUniqueLocks).toBe(2);
    expect(locks.rows.map((r) => r.key)).toEqual(["live-lease"]);
    // Swept by expiry at the pass time itself, never a 90-day retention cutoff.
    expect(locks.calls).toEqual([now, now]);
  });

  it("re-run is a no-op (idempotent)", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const locks = memLockTable();
    locks.rows.push(
      { key: "expired", expiresAt: new Date(now.getTime() - 1000) },
      { key: "live", expiresAt: new Date(now.getTime() + 3600_000) },
    );
    const stores = memStores(now, locks);

    await pruneModelTables(stores, now);
    const second = (await pruneModelTables(stores, now)) as CountsWithLocks;

    expect(second.jobUniqueLocks).toBe(0);
    expect(locks.rows.map((r) => r.key)).toEqual(["live"]);
  });

  it("drains a multi-batch lock backlog in one pass and sums the counts", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const returns = [PRUNE_DELETE_BATCH_SIZE, 3];
    const calls: Date[] = [];
    const locks: LockSweeper = {
      async sweepExpired(at: Date): Promise<number> {
        calls.push(at);
        return returns.length > 0 ? returns.shift()! : 0;
      },
    };

    const counts = (await pruneModelTables(memStores(now, locks), now)) as CountsWithLocks;

    expect(counts.jobUniqueLocks).toBe(PRUNE_DELETE_BATCH_SIZE + 3);
    expect(calls).toEqual([now, now, now]);
  });

  it("stops at the per-table batch cap and warns with the lock table capped", async () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      let calls = 0;
      const locks: LockSweeper = {
        async sweepExpired(_at: Date): Promise<number> {
          calls++;
          return PRUNE_DELETE_BATCH_SIZE;
        },
      };

      const counts = (await pruneModelTables(memStores(now, locks), now)) as CountsWithLocks;

      expect(counts.jobUniqueLocks).toBe(PRUNE_DELETE_BATCH_SIZE * PRUNE_DELETE_MAX_BATCHES);
      expect(calls).toBe(PRUNE_DELETE_MAX_BATCHES);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("batch cap");
      const payload = warn.mock.calls[0]![1] as Record<string, unknown>;
      expect(payload.cappedTables).toEqual(["jobUniqueLocks"]);
      expect(info).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});

// The shared fixture validates testDatabaseUrl() before constructing a driver,
// pins credentials/port, and migrates only its owned schema (no public writes).
describe.skipIf(!process.env.DATABASE_URL)("unique-lock sweep (test Postgres)", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
    const { migrate } = await import("../src/sessions");
    await migrate(sql as unknown as Parameters<typeof migrate>[0]);
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  async function lockKeys(): Promise<string[]> {
    const rows = await sql<{ key: string }[]>`select key from job_unique_locks order by key`;
    return rows.map((r) => r.key);
  }

  it("sweeps expired locks only; live leases and unrelated keys survive; re-runs clean", async () => {
    await sql`delete from job_unique_locks`;
    await sql`insert into job_unique_locks (key, expires_at) values
      ('sweep-expired-recent', clock_timestamp() - interval '1 second'),
      ('sweep-expired-ancient', clock_timestamp() - interval '400 days'),
      ('sweep-live-lease', clock_timestamp() + interval '1 hour'),
      ('sweep-unrelated-live', clock_timestamp() + interval '1 day')`;

    const counts = (await pruneModelTables(pgPruneStores(sql), new Date())) as CountsWithLocks;

    expect(counts.jobUniqueLocks).toBe(2);
    expect(await lockKeys()).toEqual(["sweep-live-lease", "sweep-unrelated-live"]);

    // Positive control: a surviving live lease still blocks a second acquire.
    expect(await pgUniqueLock(sql).acquire("sweep-live-lease", 300)).toBeNull();

    const second = (await pruneModelTables(pgPruneStores(sql), new Date())) as CountsWithLocks;
    expect(second.jobUniqueLocks).toBe(0);
    expect(await lockKeys()).toEqual(["sweep-live-lease", "sweep-unrelated-live"]);
  });

  it("acquire/release unchanged; a never-re-dispatched key no longer accumulates", async () => {
    await sql`delete from job_unique_locks`;
    const lock = pgUniqueLock(sql);
    const key = "sweep-lifecycle";

    const first = await lock.acquire(key, 300);
    expect(first).toEqual(expect.any(String));
    expect(await lock.acquire(key, 300)).toBeNull(); // live lease holds

    // The daily pass must not disturb the live lease.
    const during = (await pruneModelTables(pgPruneStores(sql), new Date())) as CountsWithLocks;
    expect(during.jobUniqueLocks).toBe(0);
    expect(await lockKeys()).toEqual([key]);
    expect(await lock.acquire(key, 300)).toBeNull();

    await lock.release(key, first!);
    const second = await lock.acquire(key, 300);
    expect(second).toEqual(expect.any(String));

    // The lease expires and the key is never dispatched again: without a
    // sweeper this row would linger forever.
    await sql`update job_unique_locks set expires_at = clock_timestamp() - interval '1 second' where key = ${key}`;
    const after = (await pruneModelTables(pgPruneStores(sql), new Date())) as CountsWithLocks;
    expect(after.jobUniqueLocks).toBe(1);
    expect(await lockKeys()).toEqual([]);

    // The swept key is immediately usable again, and the stale lease token
    // still cannot release its successor (fenced release unchanged).
    const third = await lock.acquire(key, 300);
    expect(third).toEqual(expect.any(String));
    await lock.release(key, second!);
    expect(await lock.acquire(key, 300)).toBeNull();
    await lock.release(key, third!);
    expect(await lockKeys()).toEqual([]);
  });

  it("each sweep statement is batch-bounded; one daily pass drains the backlog", async () => {
    await sql`delete from job_unique_locks`;
    const total = PRUNE_DELETE_BATCH_SIZE + 3;
    await sql`insert into job_unique_locks (key, expires_at)
      select 'sweep-batch-' || g, clock_timestamp() - interval '1 hour'
      from generate_series(1, ${total}) as g`;

    const stores = pgPruneStores(sql) as StoresWithLocks;
    expect(typeof stores.jobUniqueLocks?.sweepExpired).toBe("function");
    expect(await stores.jobUniqueLocks.sweepExpired(new Date())).toBe(PRUNE_DELETE_BATCH_SIZE);

    const counts = (await pruneModelTables(pgPruneStores(sql), new Date())) as CountsWithLocks;
    expect(counts.jobUniqueLocks).toBe(3);
    expect(await lockKeys()).toEqual([]);

    const second = (await pruneModelTables(pgPruneStores(sql), new Date())) as CountsWithLocks;
    expect(second.jobUniqueLocks).toBe(0);
  });
});
