// Builder-owned pins for the terminal-claim reopen timeout and failure branches.
//
// `reopenTerminalClaim` (src/jobs/consumer.ts:205-232) races the pendingSync /
// deferSync reopen against LEDGER_TIMEOUT_MS (:13, 2000 ms) after a failed
// terminal-intent note: a hang warns "sync terminal claim reopen timed out"
// with the sanitized scope (:211-213); a throw warns "sync terminal claim
// reopen failed" with a class-only exception (:225-227); neither may hold the
// batch — the settlement race still
// runs this delivery (docs/runbook-logs.md reopen rows). The review-pins
// harness (test/queue-terminal-intent-review-pins.test.ts:221-289) stubs both
// store calls to always resolve and asserts only the success path, so these
// pins cover the hang and throw branches. Hermetic stub stores only; no
// database, queue or network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import type {
  BotClient,
  BotFailure,
  EventStore,
  QueueLedger,
  SyncAttempt,
  UniqueLock,
} from "../src/jobs/types";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const now = () => new Date(NOW.getTime());
const EVENT_KEY = "e-pin";
const IDEMPOTENCY_KEY = "99999999-9999-4999-8999-999999999999";
const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEASE_TOKEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// LEDGER_TIMEOUT_MS is not exported: pin its value (src/jobs/consumer.ts:13)
// so a bound change fails the 1999 ms / 2000 ms timing assertions below.
const LEDGER_TIMEOUT_MS = 2000;
const TIMEOUT_WARN = "sync terminal claim reopen timed out";
const FAILURE_WARN = "sync terminal claim reopen failed";

// Secret-shaped seeds (synthetic markers, never real credentials): a throwing
// store carries one in its message, and no logged argument may contain it.
const PENDING_SECRET = "***synthetic-reopen-pending-secret-7f3a***";
const DEFER_SECRET = "***synthetic-reopen-defer-secret-9c1e***";

class ReopenStoreError extends Error {
  override name = "ReopenStoreError";
}

const refusal: BotFailure = {
  ok: false,
  code: "action_not_allowed",
  status: 403,
  requestId: "r1",
  message: "flag off with provider-only detail",
  retryable: false,
  retryAfterSeconds: null,
};

function pendingAttempt(): SyncAttempt {
  return {
    idempotencyKey: IDEMPOTENCY_KEY,
    eventKey: EVENT_KEY,
    revision: 1,
    mirroredAt: new Date("2026-10-01T11:00:00.000Z"),
    state: "pending",
    requestAttempts: 1,
    nextAttemptAt: new Date("2026-10-01T11:00:00.000Z"),
    action: "event.upsert",
    payload: {
      eventKey: EVENT_KEY,
      name: "Game night",
      startsAt: "2026-10-01T13:00:00.000Z",
      endsAt: "2026-10-01T14:00:00.000Z",
      location: "Discord",
      description: null,
    },
  };
}

function carrier(over: Record<string, unknown> = {}) {
  return {
    kind: "sync-event",
    eventKey: EVENT_KEY,
    idempotencyKey: IDEMPOTENCY_KEY,
    leaseToken: LEASE_TOKEN,
    jobId: JOB_ID,
    ...over,
  };
}

let warns: unknown[][];
let errors: unknown[][];
let infos: unknown[][];
beforeEach(() => {
  warns = [];
  errors = [];
  infos = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => void infos.push(a));
});
afterEach(() => vi.restoreAllMocks());

const reopenWarns = (message: string) => warns.filter((c) => c[0] === message);
const failingAlerts = () =>
  errors.filter((a) => a.map(String).join(" ").includes('"event":"queue.failing"'));
const allLoggedJson = () => JSON.stringify([...warns, ...errors, ...infos]);

type ReopenMode = "ok" | "hang" | "throw";

function setup(reopen: { pending: ReopenMode; defer: ReopenMode }) {
  const prepared = pendingAttempt();
  const upsertEvent = vi.fn(async () => refusal);
  const bot = {
    upsertEvent,
    cancelEvent: vi.fn(async () => refusal),
    postAnnouncement: vi.fn(),
    assignRole: vi.fn(),
  } as unknown as BotClient;
  // Wedged settlement with a rejecting intent note: the released-only retry
  // path, the same scenario as the success-path reopen pin, so the only
  // difference under test is the reopen branch itself.
  const failSync = vi.fn(async (_key: string) => {
    throw new Error("settlement store unavailable");
  });
  const noteTerminalIntent = vi.fn(async (_key: string, _reason: string) => {
    throw new Error("intent store unavailable");
  });
  const pendingSync = vi.fn((_eventKey: string): Promise<SyncAttempt | null> => {
    if (reopen.pending === "hang") return new Promise<SyncAttempt>(() => {});
    if (reopen.pending === "throw") throw new ReopenStoreError(PENDING_SECRET);
    return Promise.resolve(prepared);
  });
  const deferSync = vi.fn((_attempt: SyncAttempt, _at: Date | null): Promise<void> => {
    if (reopen.defer === "hang") return new Promise<void>(() => {});
    if (reopen.defer === "throw") throw new ReopenStoreError(DEFER_SECRET);
    return Promise.resolve();
  });
  const events = {
    prepareSync: vi.fn(async () => prepared),
    claimSync: vi.fn(async (attempt: SyncAttempt) => attempt),
    completeSync: vi.fn(async () => {}),
    deferSync,
    failSync,
    noteTerminalIntent,
    needsSync: async () => false,
    pendingSync,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
  } as unknown as EventStore;
  const ledger = {
    enqueued: vi.fn(async () => {}),
    reserved: vi.fn(async (_jobId: string) => {}),
    released: vi.fn(async (_jobId: string, _at: Date) => {}),
    dequeued: vi.fn(async (_jobId: string) => {}),
    failed: vi.fn(async (_jobId: string, _k: string, _key: string | null, _r: string) => {}),
  } as unknown as QueueLedger;
  const lock = {
    acquire: vi.fn(async () => LEASE_TOKEN),
    release: vi.fn(async () => {}),
  } as unknown as UniqueLock;
  const message = (body: unknown, attempts = 1) => ({
    body,
    attempts,
    ack: vi.fn(() => {}),
    retry: vi.fn((_o?: { delaySeconds?: number }) => {}),
  });
  return {
    prepared,
    upsertEvent,
    failSync,
    noteTerminalIntent,
    pendingSync,
    deferSync,
    ledger,
    lock,
    message,
    deps: { bot, events, ledger, lock, now },
  };
}

describe("terminal-claim reopen timeout", () => {
  it("a hung pendingSync warns once at the 2s bound and still retries released-only", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ pending: "hang", defer: "ok" });
      const m = s.message(carrier(), 1);

      const p = consume({ messages: [m] }, s.deps);
      await vi.advanceTimersByTimeAsync(LEDGER_TIMEOUT_MS - 1);
      expect(reopenWarns(TIMEOUT_WARN)).toHaveLength(0);
      expect(reopenWarns(FAILURE_WARN)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(reopenWarns(TIMEOUT_WARN)).toHaveLength(1);
      await p;

      // Exactly the timeout warn with the sanitized scope, never the failure warn.
      const timeouts = reopenWarns(TIMEOUT_WARN);
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toEqual([TIMEOUT_WARN, { scope: "sync-event:e-pin" }]);
      expect(reopenWarns(FAILURE_WARN)).toHaveLength(0);
      // The reopen never resolved, so the defer never ran; the bot flow did.
      expect(s.upsertEvent).toHaveBeenCalledTimes(1);
      expect(s.pendingSync).toHaveBeenCalledExactlyOnceWith(EVENT_KEY);
      expect(s.deferSync).not.toHaveBeenCalled();
      // Settlement still ran and the released-only retry still landed.
      expect(s.noteTerminalIntent).toHaveBeenCalledTimes(1);
      expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
      expect(s.ledger.reserved).toHaveBeenCalledExactlyOnceWith(JOB_ID);
      expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
      expect(m.retry).toHaveBeenCalledExactlyOnceWith();
      expect(m.ack).not.toHaveBeenCalled();
      expect(s.lock.release).not.toHaveBeenCalled();
      expect(s.ledger.failed).not.toHaveBeenCalled();
      expect(failingAlerts()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hung deferSync warns once at the 2s bound and still retries released-only", async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ pending: "ok", defer: "hang" });
      const m = s.message(carrier(), 1);

      const p = consume({ messages: [m] }, s.deps);
      await vi.advanceTimersByTimeAsync(LEDGER_TIMEOUT_MS - 1);
      expect(reopenWarns(TIMEOUT_WARN)).toHaveLength(0);
      expect(reopenWarns(FAILURE_WARN)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(reopenWarns(TIMEOUT_WARN)).toHaveLength(1);
      await p;

      const timeouts = reopenWarns(TIMEOUT_WARN);
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toEqual([TIMEOUT_WARN, { scope: "sync-event:e-pin" }]);
      expect(reopenWarns(FAILURE_WARN)).toHaveLength(0);
      // The pending lookup resolved, then the defer hung: exactly one call each.
      expect(s.upsertEvent).toHaveBeenCalledTimes(1);
      expect(s.pendingSync).toHaveBeenCalledExactlyOnceWith(EVENT_KEY);
      expect(s.deferSync).toHaveBeenCalledExactlyOnceWith(s.prepared, NOW);
      expect(s.noteTerminalIntent).toHaveBeenCalledTimes(1);
      expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
      expect(s.ledger.reserved).toHaveBeenCalledExactlyOnceWith(JOB_ID);
      expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
      expect(m.retry).toHaveBeenCalledExactlyOnceWith();
      expect(m.ack).not.toHaveBeenCalled();
      expect(s.lock.release).not.toHaveBeenCalled();
      expect(s.ledger.failed).not.toHaveBeenCalled();
      expect(failingAlerts()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("terminal-claim reopen failure", () => {
  it("a throwing pendingSync warns once class-only and leaks no message", async () => {
    const s = setup({ pending: "throw", defer: "ok" });
    const m = s.message(carrier(), 1);

    await consume({ messages: [m] }, s.deps);

    // Exactly the failure warn with the class, never the timeout warn and
    // never the thrown message anywhere in the logged arguments.
    const failures = reopenWarns(FAILURE_WARN);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual([FAILURE_WARN, { exception: "ReopenStoreError" }]);
    expect(reopenWarns(TIMEOUT_WARN)).toHaveLength(0);
    expect(allLoggedJson()).not.toContain(PENDING_SECRET);
    expect(s.upsertEvent).toHaveBeenCalledTimes(1);
    expect(s.pendingSync).toHaveBeenCalledExactlyOnceWith(EVENT_KEY);
    expect(s.deferSync).not.toHaveBeenCalled();
    expect(s.noteTerminalIntent).toHaveBeenCalledTimes(1);
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.reserved).toHaveBeenCalledExactlyOnceWith(JOB_ID);
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.lock.release).not.toHaveBeenCalled();
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(failingAlerts()).toEqual([]);
  });

  it("a throwing deferSync warns once class-only and leaks no message", async () => {
    const s = setup({ pending: "ok", defer: "throw" });
    const m = s.message(carrier(), 1);

    await consume({ messages: [m] }, s.deps);

    const failures = reopenWarns(FAILURE_WARN);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual([FAILURE_WARN, { exception: "ReopenStoreError" }]);
    expect(reopenWarns(TIMEOUT_WARN)).toHaveLength(0);
    expect(allLoggedJson()).not.toContain(DEFER_SECRET);
    expect(s.upsertEvent).toHaveBeenCalledTimes(1);
    expect(s.pendingSync).toHaveBeenCalledExactlyOnceWith(EVENT_KEY);
    expect(s.deferSync).toHaveBeenCalledExactlyOnceWith(s.prepared, NOW);
    expect(s.noteTerminalIntent).toHaveBeenCalledTimes(1);
    expect(s.failSync).toHaveBeenCalledExactlyOnceWith(IDEMPOTENCY_KEY);
    expect(s.ledger.reserved).toHaveBeenCalledExactlyOnceWith(JOB_ID);
    expect(s.ledger.released).toHaveBeenCalledExactlyOnceWith(JOB_ID, NOW);
    expect(m.retry).toHaveBeenCalledExactlyOnceWith();
    expect(m.ack).not.toHaveBeenCalled();
    expect(s.lock.release).not.toHaveBeenCalled();
    expect(s.ledger.failed).not.toHaveBeenCalled();
    expect(failingAlerts()).toEqual([]);
  });
});
