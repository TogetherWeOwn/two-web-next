// Acceptance: a hung lock acquire or queue send fails fast instead of
// stalling the caller.
//
// Contract under test (producer side only):
// - `lock.acquire` and `queue.send` each race an independent 2000 ms
//   deadline (the same budget the existing failure-path lock release and
//   the consumer's ledger/lock bounds already use).
// - On expiry the dispatch throws a transport-class error
//   (`BotTransportError`), releases any lease it acquired, and the queue
//   ledger enrolment for the abandoned send is compensated.
// - The bound lives in the shared producer, so the reconcile redispatch
//   inherits it with no per-caller wiring.
// - Prompt acquire/send behaviour is unchanged: success, a null acquire
//   (contender), and a fast send rejection keep their current outcomes.
//
// Hermetic: in-memory lock/ledger/queue doubles and fake timers, following
// test/jobs-lock-ownership.test.ts. No database, queue, or network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileEvents } from "../src/jobs/cron";
import { trackingQueue } from "../src/jobs/ledger";
import { dispatchSyncEvent, uniqueKey } from "../src/jobs/sync-event";
import {
  BotTransportError,
  type EventStore,
  type QueueLedger,
  type QueueMessage,
  type UniqueLock,
} from "../src/jobs/types";

type SyncMessage = Extract<QueueMessage, { kind: "sync-event" }>;

// The deadline budget: matches the established 2000 ms lock/ledger bounds.
const BUDGET_MS = 2000;
const eventKey = "deadline-event";
const key = uniqueKey(eventKey);

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
    release: vi.fn(async (k, token) => {
      if (rows.get(k)?.token === token) rows.delete(k);
    }),
  };
  return { lock, rows };
}

function ledgerSpy(): QueueLedger {
  return {
    enqueued: vi.fn(async () => {}),
    reserved: vi.fn(async () => {}),
    released: vi.fn(async () => {}),
    dequeued: vi.fn(async () => {}),
    failed: vi.fn(async () => {}),
  };
}

// The real producer wiring: dispatchSyncEvent over trackingQueue, so the
// ledger enrolment and its compensation are observable alongside the lock.
function producer(lock: UniqueLock, transport: (body: unknown) => Promise<void>) {
  const sent: SyncMessage[] = [];
  const depth = ledgerSpy();
  const queue = trackingQueue(
    {
      send: async (body: unknown) => {
        await transport(body);
        sent.push(body as SyncMessage);
      },
    },
    depth,
  );
  return { sent, depth, queue, dispatch: () => dispatchSyncEvent(queue, lock, eventKey) };
}

// Observe settlement without ever hanging the test on a never-settling call.
function observed(promise: Promise<unknown>) {
  const state: { settled: boolean; error?: unknown; value?: unknown } = { settled: false };
  void promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

const never = () => new Promise<never>(() => {});

describe("hung producer calls fail fast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("control: prompt acquire and send dispatch normally and leave no timer behind", async () => {
    const { lock } = memoryLock();
    const p = producer(lock, async () => {});
    await expect(p.dispatch()).resolves.toBe(true);
    expect(p.sent).toHaveLength(1);
    expect(lock.release).not.toHaveBeenCalled();
    expect(p.depth.enqueued).toHaveBeenCalledOnce();
    expect(p.depth.dequeued).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("control: slow-but-in-budget acquire then send still succeeds (deadlines are per-call)", async () => {
    const { lock, rows } = memoryLock();
    const realAcquire = vi.mocked(lock.acquire).getMockImplementation()!;
    vi.mocked(lock.acquire).mockImplementation(
      (k, ttl) =>
        new Promise((resolve) => {
          setTimeout(() => void realAcquire(k, ttl).then(resolve), 1500);
        }),
    );
    const p = producer(
      lock,
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1500);
        }),
    );
    const state = observed(p.dispatch());
    // 3000 ms total exceeds one budget, but neither call exceeds its own.
    await vi.advanceTimersByTimeAsync(3000);
    expect(state.settled).toBe(true);
    expect(state.error).toBeUndefined();
    expect(state.value).toBe(true);
    expect(p.sent).toHaveLength(1);
    expect(lock.release).not.toHaveBeenCalled();
    expect(rows.get(key)?.token).toBe(p.sent[0]!.leaseToken);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("control: a contender's null acquire still returns false without sending or releasing", async () => {
    const { lock, rows } = memoryLock();
    const owner = await lock.acquire(key, 300);
    const p = producer(lock, async () => {});
    await expect(p.dispatch()).resolves.toBe(false);
    expect(p.sent).toHaveLength(0);
    expect(lock.release).not.toHaveBeenCalled();
    expect(rows.get(key)?.token).toBe(owner);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("control: a fast send rejection still propagates its original error and frees the lease", async () => {
    const { lock, rows } = memoryLock();
    const sendError = new Error("fixture send failure");
    const p = producer(lock, async () => {
      throw sendError;
    });
    await expect(p.dispatch()).rejects.toBe(sendError);
    expect(rows.has(key)).toBe(false);
    expect(p.depth.dequeued).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung lock.acquire rejects with a transport error at the deadline and sends nothing", async () => {
    const { lock } = memoryLock();
    vi.mocked(lock.acquire).mockImplementation(() => never());
    const p = producer(lock, async () => {});
    const state = observed(p.dispatch());
    await vi.advanceTimersByTimeAsync(0);
    expect(lock.acquire).toHaveBeenCalledExactlyOnceWith(key, 300);

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(BotTransportError);
    // No lease was ever granted, so nothing is held and nothing is released;
    // the send and its ledger enrolment never start.
    expect(p.sent).toHaveLength(0);
    expect(lock.release).not.toHaveBeenCalled();
    expect(p.depth.enqueued).not.toHaveBeenCalled();
    expect(p.depth.dequeued).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a lease granted only after the acquire deadline is released, never used", async () => {
    let grant!: (token: string) => void;
    const lock: UniqueLock = {
      acquire: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            grant = resolve;
          }),
      ),
      release: vi.fn(async () => {}),
    };
    const send = vi.fn(async () => {});
    const state = observed(dispatchSyncEvent({ send }, lock, eventKey));

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(BotTransportError);
    expect(send).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();

    // The abandoned acquire finally grants a lease: the producer must free
    // it rather than leave the event locked until TTL with no carrier sent.
    grant("late-lease");
    await vi.advanceTimersByTimeAsync(0);
    expect(lock.release).toHaveBeenCalledExactlyOnceWith(key, "late-lease");
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung queue.send rejects with a transport error at the deadline, frees its lease and compensates the ledger", async () => {
    const { lock, rows } = memoryLock();
    const transportBodies: SyncMessage[] = [];
    const p = producer(lock, (body) => {
      transportBodies.push(body as SyncMessage);
      return never();
    });
    const state = observed(p.dispatch());
    await vi.advanceTimersByTimeAsync(0);
    expect(transportBodies).toHaveLength(1);
    const attempted = transportBodies[0]!;
    expect(attempted.leaseToken).toEqual(expect.any(String));
    expect(attempted.jobId).toEqual(expect.any(String));

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(BotTransportError);
    // The acquired lease is compensated with its own token only...
    expect(lock.release).toHaveBeenCalledExactlyOnceWith(key, attempted.leaseToken);
    expect(rows.has(key)).toBe(false);
    // ...and the ledger enrolment for the abandoned send is compensated
    // under the exact job id that was enqueued.
    expect(p.depth.enqueued).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ jobId: attempted.jobId, key }),
    );
    expect(p.depth.dequeued).toHaveBeenCalledExactlyOnceWith(attempted.jobId);
    expect(vi.getTimerCount()).toBe(0);

    // The freed lease admits the next dispatch immediately.
    await expect(producer(lock, async () => {}).dispatch()).resolves.toBe(true);
  });

  it("reconcile redispatch inherits the bound: a hung acquire fails the pass fast", async () => {
    const { lock } = memoryLock();
    vi.mocked(lock.acquire).mockImplementation(() => never());
    const p = producer(lock, async () => {});
    const events = {
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [eventKey],
      pendingSync: async () => null,
    } as unknown as EventStore;
    const state = observed(reconcileEvents({ events, queue: p.queue, lock }));
    await vi.advanceTimersByTimeAsync(0);
    expect(lock.acquire).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(BotTransportError);
    expect(p.sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconcile redispatch inherits the bound: a hung send fails fast and frees the lease", async () => {
    const { lock, rows } = memoryLock();
    const p = producer(lock, () => never());
    const events = {
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [eventKey],
      pendingSync: async () => null,
    } as unknown as EventStore;
    const state = observed(reconcileEvents({ events, queue: p.queue, lock }));
    await vi.advanceTimersByTimeAsync(0);
    expect(p.depth.enqueued).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(state.settled).toBe(true);
    expect(state.error).toBeInstanceOf(BotTransportError);
    expect(rows.has(key)).toBe(false);
    expect(p.depth.dequeued).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
