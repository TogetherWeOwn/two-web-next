// Ledger ReconcileEventsCommandTest pin (TOG-12619): the reconcile route
// fails loudly on unknown cron and single-flights on `events:reconcile`
// without running close/materialize/redispatch. Mirrors the prune
// single-flight pin in test/prune.test.ts:138.
//
// Memory fakes always run; live round-trips use a guarded disposable schema
// on agent-testdb or the explicitly allowed GitHub CI Postgres service.
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PRUNE_CRON, RECONCILE_CRON } from "../src/jobs/constants";
import { reconcileEvents, runScheduled } from "../src/jobs/cron";
import { pgSingleFlight } from "../src/jobs/postgres";
import type { EventStore, TxClient } from "../src/jobs/types";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

function fakeStore() {
  return {
    closeFinished: vi.fn(async (_now: Date) => 0),
    materializeSeries: vi.fn(async () => 0),
    staleEventKeys: vi.fn(async (): Promise<string[]> => []),
    find: async () => null,
    recordMirrored: async () => {},
  };
}

type FakeStore = ReturnType<typeof fakeStore> & EventStore;

function fakeQueue() {
  const sent: unknown[] = [];
  return { sent, send: async (body: unknown) => void sent.push(body) };
}

function fakeLock() {
  const held = new Set<string>();
  return {
    held,
    acquire: async (k: string) => (held.has(k) ? null : (held.add(k), crypto.randomUUID())),
    release: async (k: string) => void held.delete(k),
  };
}

function reconcileJobs(store: FakeStore) {
  const queue = fakeQueue();
  const lock = fakeLock();
  const reconcile = vi.fn(async (_db: unknown) => {
    await reconcileEvents({ events: store, queue, lock });
  });
  const prune = vi.fn(async (_db: unknown) => {});
  return { store, queue, lock, reconcile, prune };
}

describe("reconcile scheduling (memory, no DB)", () => {
  it("unknown cron throws instead of silently skipping", async () => {
    const store = fakeStore() as FakeStore;
    const jobs = reconcileJobs(store);
    const flight = vi.fn(async (_name: string, _fn: (db: TxClient) => Promise<void>) => true);
    await expect(runScheduled("5 4 * * *", flight, jobs)).rejects.toThrow(/unknown cron/);
    expect(flight).not.toHaveBeenCalled();
    expect(jobs.reconcile).not.toHaveBeenCalled();
    expect(jobs.prune).not.toHaveBeenCalled();
    expect(store.closeFinished).not.toHaveBeenCalled();
    expect(store.materializeSeries).not.toHaveBeenCalled();
    expect(store.staleEventKeys).not.toHaveBeenCalled();
  });

  it("held events:reconcile flight skips without running close/materialize/redispatch", async () => {
    const store = fakeStore() as FakeStore;
    const jobs = reconcileJobs(store);
    expect(await runScheduled(RECONCILE_CRON, async () => false, jobs)).toBe(false);
    expect(jobs.reconcile).not.toHaveBeenCalled();
    expect(jobs.prune).not.toHaveBeenCalled();
    expect(store.closeFinished).not.toHaveBeenCalled();
    expect(store.materializeSeries).not.toHaveBeenCalled();
    expect(store.staleEventKeys).not.toHaveBeenCalled();
    expect(jobs.queue.sent).toEqual([]);
  });

  it("released flight runs the reconcile job once (and never the prune job)", async () => {
    const store = fakeStore() as FakeStore;
    const jobs = reconcileJobs(store);
    const tx = {};
    expect(
      await runScheduled(RECONCILE_CRON, async (_name, fn) => (await fn(tx as never), true), jobs),
    ).toBe(true);
    expect(jobs.reconcile).toHaveBeenCalledTimes(1);
    expect(jobs.reconcile).toHaveBeenCalledWith(tx);
    expect(jobs.prune).not.toHaveBeenCalled();
    expect(store.closeFinished).toHaveBeenCalledTimes(1);
    expect(store.materializeSeries).toHaveBeenCalledTimes(1);
    expect(store.staleEventKeys).toHaveBeenCalledTimes(1);
  });

  it("prune cron still routes to prune, not reconcile", async () => {
    const store = fakeStore() as FakeStore;
    const jobs = reconcileJobs(store);
    expect(await runScheduled(PRUNE_CRON, async () => false, jobs)).toBe(false);
    expect(jobs.reconcile).not.toHaveBeenCalled();
    expect(jobs.prune).not.toHaveBeenCalled();
    expect(store.closeFinished).not.toHaveBeenCalled();
  });
});

// The shared fixture validates testDatabaseUrl() before constructing a driver,
// pins credentials/port, and migrates only its owned schema (no public writes).
describe.skipIf(!process.env.DATABASE_URL)("reconcile scheduling (test Postgres)", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  // Observe the held advisory lock rather than guessing with a sleep.
  // pg_try_advisory_xact_lock never blocks, so there is no waiter in
  // pg_stat_activity: the holder sits idle-in-transaction on a Client wait.
  // Poll pg_locks (joined to pg_stat_activity for the database scope) for
  // the holder pid's granted advisory lock instead. performance's real
  // clock bounds failure. House pattern: waitForEventLock() at
  // test/event-mutation-invariants.test.ts:462-476.
  async function waitForReconcileLock(pid: number): Promise<void> {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const [held] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks l
        join pg_stat_activity a on a.pid = l.pid
        where l.pid = ${pid} and l.locktype = 'advisory' and l.granted
          and a.datname = current_database()`;
      if (held!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("reconcile flight did not hold its advisory lock");
  }

  it("held events:reconcile flight skips without store calls (real pg flight)", async () => {
    const store = fakeStore() as FakeStore;
    const jobs = reconcileJobs(store);
    const flight = pgSingleFlight(sql);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let holderPid = 0;
    let entered!: () => void;
    const enteredGate = new Promise<void>((r) => (entered = r));
    const first = flight("events:reconcile", async (tx) => {
      // The flight body runs only after pg_try_advisory_xact_lock succeeds,
      // so entry proves acquisition; the pid lets the observer confirm the
      // server-side lock instead of racing a sleep.
      const [row] = await (tx as unknown as TxClient)`select pg_backend_pid() as pid`;
      holderPid = (row as { pid: number }).pid;
      entered();
      await gate;
    });
    let skipped = false;
    try {
      // Race entry against the flight so a non-entering flight fails fast
      // with its real error instead of hanging until testTimeout.
      await Promise.race([
        enteredGate,
        first.then((ran) => {
          if (!ran) throw new Error("reconcile flight did not acquire its lock");
        }),
      ]);
      await waitForReconcileLock(holderPid);
      skipped = await runScheduled(RECONCILE_CRON, flight, jobs);
    } finally {
      release();
    }
    expect(await first).toBe(true);
    expect(skipped).toBe(false);
    expect(jobs.reconcile).not.toHaveBeenCalled();
    expect(store.closeFinished).not.toHaveBeenCalled();
    expect(store.materializeSeries).not.toHaveBeenCalled();
    expect(store.staleEventKeys).not.toHaveBeenCalled();
  });

  it("released flight runs once with zero prior store calls (real pg flight)", async () => {
    const store = fakeStore() as FakeStore;
    const jobs = reconcileJobs(store);
    const flight = pgSingleFlight(sql);
    expect(await runScheduled(RECONCILE_CRON, flight, jobs)).toBe(true);
    expect(jobs.reconcile).toHaveBeenCalledTimes(1);
    expect(jobs.prune).not.toHaveBeenCalled();
    expect(store.closeFinished).toHaveBeenCalledTimes(1);
    expect(store.materializeSeries).toHaveBeenCalledTimes(1);
    expect(store.staleEventKeys).toHaveBeenCalledTimes(1);
  });
});
