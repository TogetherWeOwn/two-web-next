import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_EVENT } from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import { trackingQueue } from "../src/jobs/ledger";
import { pgUniqueLock } from "../src/jobs/postgres";
import { dispatchSyncEvent, uniqueKey } from "../src/jobs/sync-event";
import { BotTransportError, type BotClient, type EventStore, type QueueLedger, type QueueMessage, type UniqueLock } from "../src/jobs/types";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

type SyncMessage = Extract<QueueMessage, { kind: "sync-event" }>;
const eventKey = "lease-regression";
const key = uniqueKey(eventKey);
const success = { ok: true, requestId: null, discordEventId: "discord-event" } as const;
const events: EventStore = {
  find: async () => ({ eventKey, mirrored: true,
    payload: { eventKey, name: "fixture", startsAt: "2026-10-01T12:00:00Z", endsAt: null, location: "", description: null } }),
  recordMirrored: async () => {}, closeFinished: async () => 0,
  materializeSeries: async () => 0, staleEventKeys: async () => [],
};
function ledger(): QueueLedger {
  return { enqueued: vi.fn(async () => {}), reserved: vi.fn(async () => {}), released: vi.fn(async () => {}),
    dequeued: vi.fn(async () => {}), failed: vi.fn(async () => {}) };
}
function carrier(body: SyncMessage, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}
function memoryLock() {
  const rows = new Map<string, { token: string; expiresAt: number }>();
  const lock: UniqueLock = {
    acquire: vi.fn(async (k, ttl) => {
      const held = rows.get(k);
      if (held && held.expiresAt >= Date.now()) return null;
      const token = crypto.randomUUID();
      rows.set(k, { token, expiresAt: Date.now() + ttl * 1000 });
      return token;
    }),
    release: vi.fn(async (k, token) => { if (rows.get(k)?.token === token) rows.delete(k); }),
  };
  return { lock, rows };
}
function producer(lock: UniqueLock, transport = vi.fn(async (_body: unknown) => {})) {
  const sent: SyncMessage[] = [];
  const depth = ledger();
  const queue = trackingQueue({ send: async (body: unknown) => {
    await transport(body);
    sent.push(body as SyncMessage);
  } }, depth);
  return { sent, depth, dispatch: () => dispatchSyncEvent(queue, lock, eventKey) };
}

describe("queue carrier lease ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["success", "refusal", "exhausted throw"] as const)("late A %s cannot release B; B completion admits C", async (terminal) => {
    const { lock, rows } = memoryLock();
    const p = producer(lock);
    expect(await p.dispatch()).toBe(true);
    const a = p.sent[0]!;
    vi.advanceTimersByTime(SYNC_EVENT.uniqueForSeconds * 1000 + 1);
    expect(await p.dispatch()).toBe(true);
    const b = p.sent[1]!;
    expect(b.leaseToken).not.toBe(a.leaseToken);
    const bot = { upsertEvent: async () => {
      if (terminal === "exhausted throw") throw new TypeError("fixture throw");
      if (terminal === "refusal") return { ok: false, code: "refused", status: 403, requestId: null,
        message: "fixture refusal", retryable: false, retryAfterSeconds: null } as const;
      return success;
    } } as unknown as BotClient;
    const old = carrier(a, terminal === "exhausted throw" ? SYNC_EVENT.tries : 1);
    await consume({ messages: [old] }, { bot, events, lock, ledger: p.depth });
    expect(old.ack).toHaveBeenCalledOnce();
    expect(lock.release).toHaveBeenCalledWith(key, a.leaseToken);
    expect(rows.get(key)?.token).toBe(b.leaseToken);
    expect(await p.dispatch()).toBe(false);
    const current = carrier(b);
    await consume({ messages: [current] }, { bot: { upsertEvent: async () => success } as unknown as BotClient,
      events, lock, ledger: p.depth });
    expect(current.ack).toHaveBeenCalledOnce();
    expect(rows.has(key)).toBe(false);
    expect(await p.dispatch()).toBe(true);
  });

  it("transport retry keeps the same ownership, job and idempotency identities past expiry", async () => {
    const { lock, rows } = memoryLock();
    const p = producer(lock);
    await p.dispatch();
    const a = p.sent[0]!;
    const original = { ...a };
    expect(a.jobId).toEqual(expect.any(String));
    expect(a.leaseToken).toEqual(expect.any(String));
    expect(a.leaseToken).not.toBe(a.idempotencyKey);
    const send = vi.fn().mockRejectedValueOnce(new BotTransportError("fixture unavailable")).mockResolvedValue(success);
    const bot = { upsertEvent: send } as unknown as BotClient;
    const retry = carrier(a, 5);
    await consume({ messages: [retry] }, { bot, events, lock, ledger: p.depth });
    expect(retry.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
    expect(retry.ack).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
    expect(a).toEqual(original);
    vi.advanceTimersByTime(SYNC_EVENT.uniqueForSeconds * 1000 + 1);
    await p.dispatch();
    const b = p.sent[1]!;
    vi.advanceTimersByTime((3600 - SYNC_EVENT.uniqueForSeconds) * 1000);
    // B has also expired, so reacquire a fresh current lease before A returns.
    await p.dispatch();
    const current = p.sent[2]!;
    expect(current.leaseToken).not.toBe(b.leaseToken);
    await consume({ messages: [carrier(a, 6)] }, { bot, events, lock, ledger: p.depth });
    expect(send.mock.calls.map((args) => args[1])).toEqual([a.idempotencyKey, a.idempotencyKey]);
    expect(rows.get(key)?.token).toBe(current.leaseToken);
    expect(await p.dispatch()).toBe(false);
    expect(p.depth.dequeued).toHaveBeenCalledWith(a.jobId);
  });

  it("a redeliverable throw keeps ownership without acquiring a new lease", async () => {
    const { lock, rows } = memoryLock();
    const p = producer(lock);
    await p.dispatch();
    const a = p.sent[0]!;
    const m = carrier(a);
    await consume({ messages: [m] }, { bot: { upsertEvent: async () => { throw new TypeError("fixture throw"); } } as unknown as BotClient,
      events, lock, ledger: p.depth });
    expect(m.retry).toHaveBeenCalledWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(rows.get(key)?.token).toBe(a.leaseToken);
    expect(lock.release).not.toHaveBeenCalled();
    expect(lock.acquire).toHaveBeenCalledTimes(1);
  });

  it("a rejected contender gets no token and sends/releases nothing", async () => {
    const { lock, rows } = memoryLock();
    const owner = await lock.acquire(key, 300);
    const p = producer(lock);
    expect(await p.dispatch()).toBe(false);
    expect(p.sent).toHaveLength(0);
    expect(lock.release).not.toHaveBeenCalled();
    expect(rows.get(key)?.token).toBe(owner);
  });

  it("failed-send compensation frees its own lease for the next dispatch", async () => {
    const { lock, rows } = memoryLock();
    const send = vi.fn(async (_body: unknown) => { throw new Error("fixture send failure"); });
    const p = producer(lock, send);
    await expect(p.dispatch()).rejects.toThrow("fixture send failure");
    const a = send.mock.calls[0]![0] as SyncMessage;
    expect(lock.release).toHaveBeenCalledWith(key, a.leaseToken);
    expect(rows.has(key)).toBe(false);
    expect(p.depth.dequeued).toHaveBeenCalledWith(a.jobId);
    expect(await producer(lock).dispatch()).toBe(true);
  });

  it("late failed-send compensation cannot delete a replacement lease", async () => {
    const { lock, rows } = memoryLock();
    const send = vi.fn(async (_body: unknown) => {
      vi.advanceTimersByTime(SYNC_EVENT.uniqueForSeconds * 1000 + 1);
      expect(await lock.acquire(key, 300)).toEqual(expect.any(String));
      throw new Error("fixture late send failure");
    });
    await expect(producer(lock, send).dispatch()).rejects.toThrow("fixture late send failure");
    const a = send.mock.calls[0]![0] as SyncMessage;
    expect(lock.release).toHaveBeenCalledWith(key, a.leaseToken);
    expect(rows.get(key)?.token).not.toBe(a.leaseToken);
    expect(await lock.acquire(key, 300)).toBeNull();
  });

  it("cleanup failure does not replace the original send error", async () => {
    const { lock } = memoryLock();
    vi.mocked(lock.release).mockRejectedValue(new Error("fixture cleanup failure"));
    await expect(producer(lock, vi.fn(async () => { throw new Error("fixture send failure"); })).dispatch())
      .rejects.toThrow("fixture send failure");
  });

  it("a hung failed-send cleanup rejects with the original error at the deadline", async () => {
    const { lock, rows } = memoryLock();
    vi.mocked(lock.release).mockImplementation(() => new Promise<void>(() => {}));
    const sendError = new Error("fixture send failure");
    const send = vi.fn(async (_body: unknown) => { throw sendError; });
    let settled = false;
    const result = producer(lock, send).dispatch().catch((error: unknown) => { settled = true; return error; });

    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await result).toBe(sendError);
    const a = send.mock.calls[0]![0] as SyncMessage;
    expect(lock.release).toHaveBeenCalledExactlyOnceWith(key, a.leaseToken);
    expect(rows.get(key)?.token).toBe(a.leaseToken);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a compensating release finishing after its deadline still cannot delete B", async () => {
    const { lock, rows } = memoryLock();
    const release = vi.mocked(lock.release).getMockImplementation()!;
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const finished = vi.fn();
    vi.mocked(lock.release).mockImplementation(async (k, token) => {
      await blocked;
      await release(k, token);
      finished();
    });
    const sendError = new Error("fixture send failure");
    const result = producer(lock, vi.fn(async () => { throw sendError; })).dispatch().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe(sendError);
    await vi.advanceTimersByTimeAsync(SYNC_EVENT.uniqueForSeconds * 1000);
    const b = await lock.acquire(key, 300);
    expect(b).toEqual(expect.any(String));
    unblock();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toHaveBeenCalledOnce();
    expect(rows.get(key)?.token).toBe(b);
    expect(await lock.acquire(key, 300)).toBeNull();
  });

  it("legacy tokenless messages ack without releasing even if other identities match B's token", async () => {
    const { lock, rows } = memoryLock();
    const token = await lock.acquire(key, 300);
    const legacy = carrier({ kind: "sync-event", eventKey, idempotencyKey: token!, jobId: token! });
    await consume({ messages: [legacy] }, { bot: { upsertEvent: async () => success } as unknown as BotClient,
      events, lock, ledger: ledger() });
    expect(legacy.ack).toHaveBeenCalledOnce();
    expect(lock.release).not.toHaveBeenCalled();
    expect(rows.get(key)?.token).toBe(token);
    expect(await lock.acquire(key, 300)).toBeNull();
    vi.advanceTimersByTime(300_001);
    expect(await lock.acquire(key, 300)).toEqual(expect.any(String));
  });
});

// Guarded fixture refuses non-test URLs before opening a driver. All DDL and
// contention operate in its disposable schema (or transaction-local temp table).
describe.skipIf(!process.env.DATABASE_URL)("Postgres atomic lease ownership", () => {
  let fixture: JobsFixture | undefined;
  beforeAll(async () => { fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 8 }); });
  afterAll(async () => { await fixture?.dispose(); });

  it("one concurrent winner owns the row; unknown/rejected contenders cannot release it", async () => {
    const sql = fixture!.client;
    const lock = pgUniqueLock(sql);
    const k = uniqueKey(crypto.randomUUID());
    const tokens = await Promise.all(Array.from({ length: 16 }, () => lock.acquire(k, 300)));
    const winners = tokens.filter((token): token is string => token !== null);
    expect(winners).toHaveLength(1);
    expect(tokens.filter((token) => token === null)).toHaveLength(15);
    const [held] = await sql`select owner_token from job_unique_locks where key = ${k}`;
    expect(held!.owner_token).toBe(winners[0]);
    await lock.release(k, crypto.randomUUID());
    expect(await lock.acquire(k, 300)).toBeNull();
    await lock.release(k, winners[0]!);
    expect(await lock.acquire(k, 300)).toEqual(expect.any(String));
  });

  it("expiry/reacquisition/late-A-release preserves B atomically until B releases or expires", async () => {
    const sql = fixture!.client;
    const lock = pgUniqueLock(sql);
    const k = uniqueKey(crypto.randomUUID());
    const a = await lock.acquire(k, 300);
    expect(a).toEqual(expect.any(String));
    await sql`update job_unique_locks set expires_at = clock_timestamp() - interval '1 second' where key = ${k}`;
    const contenders = await Promise.all(Array.from({ length: 16 }, () => lock.acquire(k, 300)));
    const winners = contenders.filter((token): token is string => token !== null);
    expect(winners).toHaveLength(1);
    const b = winners[0]!;
    expect(b).not.toBe(a);
    const [before] = await sql`select owner_token, expires_at from job_unique_locks where key = ${k}`;
    await lock.release(k, a!);
    expect(await sql`select owner_token, expires_at from job_unique_locks where key = ${k}`).toEqual([before]);
    expect(await lock.acquire(k, 300)).toBeNull();
    await lock.release(k, b);
    const c = await lock.acquire(k, 300);
    expect(c).toEqual(expect.any(String));
    await sql`update job_unique_locks set expires_at = clock_timestamp() - interval '1 second' where key = ${k}`;
    const d = await lock.acquire(k, 300);
    expect(d).toEqual(expect.any(String));
    expect(d).not.toBe(c);
    await lock.release(k, b);
    expect(await lock.acquire(k, 300)).toBeNull();
  });

  it("additive migration preserves existing leases and expiry upgrades null ownership", async () => {
    const migration = readFileSync(fileURLToPath(new URL("../drizzle/1016_job-lock-ownership.sql", import.meta.url).href), "utf8");
    await fixture!.client.begin(async (tx) => {
      await tx`create temporary table job_unique_locks (key text primary key, expires_at timestamptz not null) on commit drop`;
      const expires = new Date(Date.now() + 300_000);
      await tx`insert into job_unique_locks (key, expires_at) values ('legacy', ${expires})`;
      await tx.unsafe(migration);
      expect(await tx`select key, expires_at, owner_token from job_unique_locks`)
        .toEqual([{ key: "legacy", expires_at: expires, owner_token: null }]);
      const lock = pgUniqueLock(tx);
      expect(await lock.acquire("legacy", 300)).toBeNull();
      await lock.release("legacy", crypto.randomUUID());
      expect(await tx`select key from job_unique_locks`).toHaveLength(1);
      await tx`update job_unique_locks set expires_at = clock_timestamp() - interval '1 second' where key = 'legacy'`;
      const token = await lock.acquire("legacy", 300);
      expect(token).toEqual(expect.any(String));
      await lock.release("legacy", token!);
      expect(await tx`select key from job_unique_locks`).toHaveLength(0);
    });
  });
});
