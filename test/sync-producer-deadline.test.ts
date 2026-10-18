import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileEvents } from "../src/jobs/cron";
import { trackingQueue } from "../src/jobs/ledger";
import { dispatchSyncEvent, PRODUCER_TIMEOUT_MS, uniqueKey } from "../src/jobs/sync-event";
import { BotTransportError } from "../src/jobs/types";
import type { EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

// The producer's lock-acquire and queue-send must race an
// independent setTimeout deadline like every neighboring op. Each case drives
// the dispatch with a never-settling stub, advances past the budget, and
// asserts the dispatch already rejected — so each fails while acquire/send
// are awaited bare, and passes once they race a deadline.
const PRODUCER_BUDGET_MS = 2000;
const eventKey = "producer-deadline";
const key = uniqueKey(eventKey);

function memLedger() {
  const rows = new Map<string, { state: string; reason?: string }>();
  const ledger: QueueLedger = {
    enqueued: async (j) => void rows.set(j.jobId, { state: "pending" }),
    reserved: async (id) => void rows.set(id, { state: "reserved" }),
    released: async (id) => void rows.set(id, { state: "released" }),
    dequeued: async (id) => void rows.delete(id),
    failed: async (id, _kind, _key, reason) => void rows.set(id, { state: "failed", reason }),
  };
  return { ledger, rows };
}

function memoryLock() {
  const rows = new Map<string, { token: string; expiresAt: number }>();
  const lock: UniqueLock = {
    acquire: vi.fn(async (k: string, ttl: number) => {
      const held = rows.get(k);
      if (held && held.expiresAt >= Date.now()) return null;
      const token = crypto.randomUUID();
      rows.set(k, { token, expiresAt: Date.now() + ttl * 1000 });
      return token;
    }),
    release: vi.fn(async (k: string, token: string) => {
      if (rows.get(k)?.token === token) rows.delete(k);
    }),
  };
  return { lock, rows };
}

function track(p: Promise<unknown>) {
  let outcome:
    | { status: "pending" }
    | { status: "fulfilled"; value: unknown }
    | {
        status: "rejected";
        reason: unknown;
      } = { status: "pending" };
  p.then(
    (value) => {
      outcome = { status: "fulfilled", value };
    },
    (reason) => {
      outcome = { status: "rejected", reason };
    },
  );
  return () => outcome;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("producer deadline", () => {
  it("pins the per-op bound so changes are deliberate", () => {
    expect(PRODUCER_TIMEOUT_MS).toBe(2000);
    expect(PRODUCER_BUDGET_MS).toBe(PRODUCER_TIMEOUT_MS);
  });

  it("a hung lock.acquire rejects within budget and holds no lease", async () => {
    const acquire = vi.fn(() => new Promise<string | null>(() => {}));
    const release = vi.fn(async (_k: string, _t: string) => {});
    const lock: UniqueLock = { acquire, release };
    const queue = trackingQueue({ send: async () => {} }, memLedger().ledger);
    const outcome = track(dispatchSyncEvent(queue, lock, eventKey));
    await vi.advanceTimersByTimeAsync(PRODUCER_BUDGET_MS + 1000);
    const result = outcome();
    expect(result.status).toBe("rejected");
    expect((result as { reason: unknown }).reason).toBeInstanceOf(BotTransportError);
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late acquire token after the deadline is released, never held", async () => {
    let resolveAcquire!: (token: string | null) => void;
    const gate = new Promise<string | null>((resolve) => {
      resolveAcquire = resolve;
    });
    const { rows } = memoryLock();
    const release = vi.fn(async (k: string, token: string) => {
      if (rows.get(k)?.token === token) rows.delete(k);
    });
    const lock: UniqueLock = { acquire: vi.fn(() => gate), release };
    const sent: unknown[] = [];
    const queue = trackingQueue(
      { send: async (b: unknown) => void sent.push(b) },
      memLedger().ledger,
    );
    const outcome = track(dispatchSyncEvent(queue, lock, eventKey));
    await vi.advanceTimersByTimeAsync(PRODUCER_BUDGET_MS + 1000);
    expect(outcome().status).toBe("rejected");
    expect(sent).toHaveLength(0);
    resolveAcquire("late-token");
    await vi.advanceTimersByTimeAsync(1000);
    expect(release).toHaveBeenCalledWith(key, "late-token");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung queue.send rejects within budget and releases the lease; the ledger row stays until the send settles", async () => {
    const { lock, rows } = memoryLock();
    const { ledger, rows: ledgerRows } = memLedger();
    let rejectTransport!: (err: unknown) => void;
    const transport = new Promise<unknown>((_resolve, reject) => {
      rejectTransport = reject;
    });
    const queue = trackingQueue({ send: () => transport }, ledger);
    const outcome = track(dispatchSyncEvent(queue, lock, eventKey));
    await vi.advanceTimersByTimeAsync(PRODUCER_BUDGET_MS + 1000);
    const result = outcome();
    expect(result.status).toBe("rejected");
    expect((result as { reason: unknown }).reason).toBeInstanceOf(BotTransportError);
    expect(rows.has(key)).toBe(false);
    // Row-without-message fails visible (phantom backlog), never silent: the
    // tracked row stays until the already-started send settles, per the pinned
    // successor contract. A late rejection still compensates it by exact jobId.
    expect(ledgerRows.size).toBe(1);
    rejectTransport(new Error("fixture late send failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(ledgerRows.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconcileEvents redispatch inherits the bound with no per-caller wiring", async () => {
    const lock: UniqueLock = {
      acquire: vi.fn(() => new Promise<string | null>(() => {})),
      release: vi.fn(async () => {}),
    };
    const queue = trackingQueue({ send: async () => {} }, memLedger().ledger);
    const due = new Date(Date.now() - 1000);
    const events = {
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [eventKey],
      pendingSync: async () => ({
        eventKey,
        idempotencyKey: "request-key",
        mirroredAt: due,
        revision: 1,
        state: "pending",
        requestAttempts: 0,
        nextAttemptAt: due,
        action: "event.upsert",
        payload: {
          eventKey,
          name: "fixture",
          startsAt: "2026-10-01T12:00:00Z",
          endsAt: null,
          location: "",
          description: null,
        },
      }),
    } as unknown as EventStore;
    const outcome = track(reconcileEvents({ events, queue, lock }));
    await vi.advanceTimersByTimeAsync(PRODUCER_BUDGET_MS + 1000);
    const result = outcome();
    expect(result.status).toBe("rejected");
    expect((result as { reason: unknown }).reason).toBeInstanceOf(BotTransportError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
