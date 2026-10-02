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

  it("held events:reconcile flight skips without store calls (real pg flight)", async () => {
    const store = fakeStore() as FakeStore;
    const jobs = reconcileJobs(store);
    const flight = pgSingleFlight(sql);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = flight("events:reconcile", async () => {
      await gate;
    });
    await new Promise((r) => setTimeout(r, 200)); // first now holds the lock
    const skipped = await runScheduled(RECONCILE_CRON, flight, jobs);
    release();
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
