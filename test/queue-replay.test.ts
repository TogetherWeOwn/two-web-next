import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { trackingQueue } from "../src/jobs/ledger";
import { pgQueueLedger } from "../src/jobs/postgres";
import { discardFailedJob, listFailedJobs } from "../src/jobs/redrive";
import {
  eventKeyFromFailedJob,
  reconcileFailedJob,
  replayFailedSyncEvent,
} from "../src/jobs/replay";
import type { EventStore, SyncAttempt, UniqueLock } from "../src/jobs/types";
import { createLedgerFixture } from "./helpers/queue-ledger-fixture";

type ReconcileStore = Pick<EventStore, "needsSync" | "pendingSync">;

const stubStore = (overrides: Partial<ReconcileStore> = {}): ReconcileStore => ({
  needsSync: async () => false,
  pendingSync: async () => null,
  ...overrides,
});

type PendingUpsert = Extract<SyncAttempt, { action: "event.upsert" }>;

function pendingAttempt(overrides: Partial<PendingUpsert> = {}): SyncAttempt {
  const base: PendingUpsert = {
    idempotencyKey: crypto.randomUUID(),
    eventKey: "e1",
    revision: 2,
    mirroredAt: new Date(),
    state: "pending",
    requestAttempts: 1,
    nextAttemptAt: new Date(Date.now() - 1000),
    action: "event.upsert",
    payload: {
      eventKey: "e1",
      name: "Night",
      startsAt: new Date().toISOString(),
      endsAt: null,
      location: "",
      description: null,
    },
  };
  return { ...base, ...overrides };
}

function memoryLock(): UniqueLock {
  const rows = new Map<string, string>();
  return {
    acquire: async (key, _ttl) => {
      if (rows.has(key)) return null;
      const token = crypto.randomUUID();
      rows.set(key, token);
      return token;
    },
    release: async (key, token) => {
      if (rows.get(key) === token) rows.delete(key);
    },
  };
}

// Offline: key parsing and per-row reconciliation need no database.
describe("sync-event replay key and reconciliation", () => {
  it("recovers the event key only from a sync-event row key", () => {
    expect(eventKeyFromFailedJob({ kind: "sync-event", key: "sync-event:e1" })).toBe("e1");
    expect(eventKeyFromFailedJob({ kind: "announcement", key: "sync-event:e1" })).toBeNull();
    expect(eventKeyFromFailedJob({ kind: "sync-event", key: null })).toBeNull();
    expect(eventKeyFromFailedJob({ kind: "sync-event", key: "e1" })).toBeNull();
    expect(eventKeyFromFailedJob({ kind: "sync-event", key: "sync-event:" })).toBeNull();
  });

  it("keeps rows outside this tool: other kinds and keys with no source link", async () => {
    const events = stubStore({ needsSync: async () => true });
    expect(await reconcileFailedJob(events, { kind: "announcement", key: null })).toMatchObject({
      action: "keep",
      eventKey: null,
    });
    expect(await reconcileFailedJob(events, { kind: "sync-event", key: null })).toMatchObject({
      action: "keep",
      eventKey: null,
    });
    expect(await reconcileFailedJob(events, { kind: "sync-event", key: "bogus" })).toMatchObject({
      action: "keep",
      eventKey: null,
    });
  });

  it("marks the dead row discard-stale when its source is clean", async () => {
    const events = stubStore({ needsSync: async () => false });
    expect(
      await reconcileFailedJob(events, { kind: "sync-event", key: "sync-event:e1" }),
    ).toMatchObject({ action: "discard-stale", eventKey: "e1" });
  });

  it("replays a dirty source with a fresh dispatch when no request is pending", async () => {
    const events = stubStore({ needsSync: async () => true, pendingSync: async () => null });
    const disposition = await reconcileFailedJob(events, {
      kind: "sync-event",
      key: "sync-event:e1",
    });
    expect(disposition).toMatchObject({ action: "replay", eventKey: "e1" });
    if (disposition.action === "replay") expect(disposition.idempotencyKey).toBeUndefined();
  });

  it("replays a due pending request under its original immutable key", async () => {
    const pending = pendingAttempt({ idempotencyKey: "original-key" });
    const events = stubStore({
      needsSync: async () => true,
      pendingSync: async () => pending,
    });
    expect(
      await reconcileFailedJob(events, { kind: "sync-event", key: "sync-event:e1" }),
    ).toMatchObject({ action: "replay", eventKey: "e1", idempotencyKey: "original-key" });
  });

  it("keeps the row when the live request is not due: in flight, future, or exhausted", async () => {
    const row = { kind: "sync-event", key: "sync-event:e1" } as const;
    const unsettled = stubStore({
      needsSync: async () => true,
      pendingSync: async () => pendingAttempt({ nextAttemptAt: null }),
    });
    expect(await reconcileFailedJob(unsettled, row)).toMatchObject({ action: "keep" });
    const future = stubStore({
      needsSync: async () => true,
      pendingSync: async () => pendingAttempt({ nextAttemptAt: new Date(Date.now() + 60_000) }),
    });
    expect(await reconcileFailedJob(future, row)).toMatchObject({ action: "keep" });
    const exhausted = stubStore({
      needsSync: async () => true,
      pendingSync: async () => pendingAttempt({ requestAttempts: 6 }),
    });
    expect(await reconcileFailedJob(exhausted, row)).toMatchObject({ action: "keep" });
  });
});

// Same posture as test/queue-redrive.test.ts: real Postgres in an isolated
// schema, never the caller's tables; skipped when DATABASE_URL is unset.
describe.skipIf(!process.env.DATABASE_URL)("sync-event replay ledger transitions", () => {
  let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
  let sql: Awaited<ReturnType<typeof createLedgerFixture>>["sql"];
  beforeAll(async () => {
    fixture = await createLedgerFixture(process.env.DATABASE_URL!);
    sql = fixture.sql;
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture.dispose();
  });

  it("replay mints a fresh live row and leaves the dead letter untouched", async () => {
    const ledger = pgQueueLedger(sql);
    const failedId = crypto.randomUUID();
    await ledger.enqueued({
      jobId: failedId,
      kind: "sync-event",
      key: "sync-event:e9",
      availableAt: new Date(Date.now() - 1000),
    });
    await ledger.failed(failedId, "sync-event", "sync-event:e9", "BotTerminalError");

    const events = stubStore({ needsSync: async () => true, pendingSync: async () => null });
    const [dead] = await listFailedJobs(sql);
    const disposition = await reconcileFailedJob(events, dead!);
    expect(disposition).toMatchObject({ action: "replay", eventKey: "e9" });
    if (disposition.action !== "replay") throw new Error("expected a replay disposition");

    const sent: unknown[] = [];
    const queue = trackingQueue(
      {
        send: async (body) => {
          sent.push(body);
        },
      },
      pgQueueLedger(sql),
    );
    await replayFailedSyncEvent(queue, memoryLock(), disposition.eventKey);

    expect(sent).toHaveLength(1);
    const live = (await sql`select job_id, kind, key from queue_jobs`).map(
      (r) => r as { job_id: unknown; kind: string; key: string },
    );
    expect(live).toHaveLength(1);
    // Fresh identity: the live row is not the dead row resurrected.
    expect(String(live[0]!.job_id)).not.toBe(failedId);
    expect(live[0]!.kind).toBe("sync-event");
    expect(live[0]!.key).toBe("sync-event:e9");
    // The dead letter stays as evidence until a confirmed recovery discards it.
    expect((await listFailedJobs(sql)).map((r) => r.jobId)).toEqual([failedId]);
  });

  it("a discard-stale row discards exactly that row", async () => {
    const ledger = pgQueueLedger(sql);
    const stale = crypto.randomUUID(),
      other = crypto.randomUUID();
    await ledger.enqueued({
      jobId: stale,
      kind: "sync-event",
      key: "sync-event:old",
      availableAt: new Date(Date.now() - 1000),
    });
    await ledger.failed(stale, "sync-event", "sync-event:old", "BotTerminalError");
    await ledger.enqueued({
      jobId: other,
      kind: "sync-event",
      key: "sync-event:live",
      availableAt: new Date(Date.now() - 1000),
    });
    await ledger.failed(other, "sync-event", "sync-event:live", "BotTerminalError");

    const events = stubStore({
      needsSync: async (eventKey) => eventKey === "live",
      pendingSync: async () => null,
    });
    const rows = await listFailedJobs(sql);
    const staleRow = rows.find((r) => r.jobId === stale)!;
    expect(await reconcileFailedJob(events, staleRow)).toMatchObject({
      action: "discard-stale",
      eventKey: "old",
    });
    expect(await discardFailedJob(sql, staleRow.id)).toBe(true);
    expect((await listFailedJobs(sql)).map((r) => r.jobId)).toEqual([other]);
  });
});
