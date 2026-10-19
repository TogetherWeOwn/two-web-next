import { describe, expect, it, vi } from "vitest";
import { SYNC_EVENT } from "../src/jobs/constants";
import { consume } from "../src/jobs/consumer";
import type { BotClient, EventStore, QueueLedger, UniqueLock } from "../src/jobs/types";

// Regression matrix for the independently-bounded ledger transitions in
// src/jobs/consumer.ts (released / failed / dequeued share the LEDGER_TIMEOUT_MS
// posture with reserved, but test/jobs.test.ts only hangs reserved()). Each case
// hangs exactly one transition for the first carrier with a never-settling
// deferred promise, proves the serial batch still reaches its disposition after
// the existing timeout, and proves the late settlement creates no second
// disposition and no unhandled rejection. Definitive failSync outcomes are
// deliberately excluded (separate owners).

const payload = {
  eventKey: "e1",
  name: "n",
  startsAt: "s",
  endsAt: null,
  location: "l",
  description: null,
};
const leaseToken = "11111111-1111-4111-8111-111111111111";
type BotFailureShape = {
  ok: false;
  code: string;
  status: number;
  requestId: null;
  message: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
};
const botFail = (o: Partial<BotFailureShape>): BotFailureShape => ({
  ok: false,
  code: "x",
  status: 503,
  requestId: null,
  message: "m",
  retryable: true,
  retryAfterSeconds: null,
  ...o,
});

function memLock(): UniqueLock & { held: Set<string> } {
  const held = new Set<string>();
  return {
    held,
    acquire: async (k) => (held.has(k) ? null : (held.add(k), leaseToken)),
    release: async (k, token) => {
      if (token === leaseToken) held.delete(k);
    },
  };
}

function memLedger(): QueueLedger & {
  rows: Map<string, { state: string; availableAt?: Date; reason?: string }>;
} {
  const rows = new Map<string, { state: string; availableAt?: Date; reason?: string }>();
  return {
    rows,
    enqueued: async (j) => void rows.set(j.jobId, { state: "pending", availableAt: j.availableAt }),
    reserved: async (id) => void rows.set(id, { ...rows.get(id), state: "reserved" } as never),
    released: async (id, at) =>
      void rows.set(id, { ...rows.get(id), state: "released", availableAt: at } as never),
    dequeued: async (id) => void rows.delete(id),
    failed: async (id, _kind, _key, reason) => void rows.set(id, { state: "failed", reason }),
  };
}

function store(over: Partial<EventStore> = {}): EventStore & { mirrored: (string | null)[] } {
  const mirrored: (string | null)[] = [];
  return {
    mirrored,
    prepareSync: async (_eventKey, idempotencyKey, mirroredAt) => ({
      eventKey: "e1",
      idempotencyKey,
      mirroredAt,
      revision: 1,
      state: "pending",
      requestAttempts: 0,
      nextAttemptAt: new Date(0),
      action: "event.upsert",
      payload,
    }),
    claimSync: async (attempt) => ({ ...attempt, requestAttempts: attempt.requestAttempts + 1 }),
    deferSync: async () => {},
    completeSync: async (_attempt, id) => void mirrored.push(id),
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async () => null,
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [],
    ...over,
  };
}

function msg(body: unknown, attempts = 1) {
  const r = { body, attempts, acked: false, retried: undefined as number | undefined | "now" };
  return Object.assign(r, {
    ack() {
      r.acked = true;
    },
    retry(o?: { delaySeconds?: number }) {
      r.retried = o?.delaySeconds ?? "now";
    },
  });
}

function ledgerWarns(warn: ReturnType<typeof vi.spyOn>, what: string) {
  return warn.mock.calls.filter((c: unknown[]) => c[0] === `queue ledger ${what} failed`);
}

function expectSanitizedTimeoutWarn(warn: ReturnType<typeof vi.spyOn>, what: string) {
  const calls = ledgerWarns(warn, what);
  expect(calls.length).toBeGreaterThanOrEqual(1);
  for (const c of calls) {
    // Class-only diagnostic: the timeout is classified as "Error", never the
    // raw message (which can carry bound values or secrets on real failures).
    expect(c[1]).toEqual({ exception: "Error" });
    expect(JSON.stringify(c)).not.toContain("timed out");
  }
  return calls;
}

describe("queue ledger timeout guards (released / failed / dequeued)", () => {
  it("a hung released on a retry outcome still retries and runs the batch; late resolve is inert", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    try {
      const bot = {
        upsertEvent: async () => botFail({ retryAfterSeconds: 42 }),
      } as unknown as BotClient;
      const base = memLedger();
      const releasedFor: string[] = [];
      const ledger = {
        ...base,
        released: async (id: string, at: Date) => {
          if (id === "j1") {
            releasedFor.push(id);
            await gate;
            return;
          }
          return base.released(id, at);
        },
      };
      const m1 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k1", jobId: "j1" }, 1);
      const m2 = msg({ kind: "sync-event", eventKey: "e2", idempotencyKey: "k2", jobId: "j2" }, 1);
      let m1Retries = 0;
      const origRetry = m1.retry.bind(m1);
      m1.retry = (o) => {
        m1Retries += 1;
        return origRetry(o);
      };
      const p = consume({ messages: [m1, m2] }, { bot, events: store(), lock: memLock(), ledger });
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      // First carrier retried with the admitted delay; the batch continued.
      expect(m1.retried).toBe(42);
      expect(m1.acked).toBe(false);
      expect(m2.retried).toBe(42);
      expect(m2.acked).toBe(false);
      expect(releasedFor).toEqual(["j1"]);
      expectSanitizedTimeoutWarn(warn, "released");
      // Late resolve creates no second disposition and no extra warning.
      const ledgerWarnsBefore = ledgerWarns(warn, "released").length;
      resolveGate();
      await vi.advanceTimersByTimeAsync(0);
      expect(m1Retries).toBe(1);
      expect(m1.retried).toBe(42);
      expect(m1.acked).toBe(false);
      expect(ledgerWarns(warn, "released").length).toBe(ledgerWarnsBefore);
    } finally {
      // Gate is always settled above before timers are restored.
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a hung released on a redeliverable throw still retries; late rejection is sanitized, not unhandled", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    let rejectGate!: (e: unknown) => void;
    const gate = new Promise<void>((_, rej) => {
      rejectGate = rej;
    });
    try {
      const bot = {
        upsertEvent: async () => {
          throw new TypeError("boom");
        },
      } as unknown as BotClient;
      const base = memLedger();
      const ledger = {
        ...base,
        released: async (id: string, at: Date) => {
          if (id === "j1") {
            await gate;
            return;
          }
          return base.released(id, at);
        },
      };
      const m1 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k1", jobId: "j1" }, 1);
      const m2 = msg({ kind: "sync-event", eventKey: "e2", idempotencyKey: "k2", jobId: "j2" }, 1);
      let m1Retries = 0;
      const origRetry = m1.retry.bind(m1);
      m1.retry = (o) => {
        m1Retries += 1;
        return origRetry(o);
      };
      const p = consume({ messages: [m1, m2] }, { bot, events: store(), lock: memLock(), ledger });
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(m1.retried).toBe("now");
      expect(m1.acked).toBe(false);
      expect(m2.retried).toBe("now");
      expectSanitizedTimeoutWarn(warn, "released");
      // Late rejection is caught by the bounded wrapper (second sanitized
      // warn), never a second retry and never an unhandled rejection.
      rejectGate(new Error("late boom"));
      await vi.advanceTimersByTimeAsync(0);
      expect(m1Retries).toBe(1);
      expect(m1.retried).toBe("now");
      const calls = ledgerWarns(warn, "released");
      expect(calls.length).toBe(2);
      for (const c of calls) {
        expect(c[1]).toEqual({ exception: "Error" });
        expect(JSON.stringify(c)).not.toContain("late boom");
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a hung failed on an exhausted throw still acks and runs the batch; late resolve is inert", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    try {
      const bot = {
        upsertEvent: async () => {
          throw new TypeError("boom");
        },
      } as unknown as BotClient;
      const base = memLedger();
      const failedFor: string[] = [];
      const ledger = {
        ...base,
        failed: async (id: string, kind: string, key: string | null, reason: string) => {
          if (id === "j1") {
            failedFor.push(id);
            await gate;
            return;
          }
          return base.failed(id, kind, key, reason);
        },
      };
      const m1 = msg(
        { kind: "sync-event", eventKey: "e1", idempotencyKey: "k1", jobId: "j1" },
        SYNC_EVENT.tries,
      );
      const m2 = msg({ kind: "sync-event", eventKey: "e2", idempotencyKey: "k2", jobId: "j2" }, 1);
      let m1Acks = 0;
      const origAck = m1.ack.bind(m1);
      m1.ack = () => {
        m1Acks += 1;
        return origAck();
      };
      const p = consume({ messages: [m1, m2] }, { bot, events: store(), lock: memLock(), ledger });
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(m1.acked).toBe(true);
      expect(m1.retried).toBeUndefined();
      expect(m2.retried).toBe("now");
      expect(failedFor).toEqual(["j1"]);
      expectSanitizedTimeoutWarn(warn, "failed");
      const ledgerWarnsBefore = ledgerWarns(warn, "failed").length;
      resolveGate();
      await vi.advanceTimersByTimeAsync(0);
      expect(m1Acks).toBe(1);
      expect(m1.acked).toBe(true);
      expect(ledgerWarns(warn, "failed").length).toBe(ledgerWarnsBefore);
    } finally {
      warn.mockRestore();
      err.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a hung failed on an ordinary terminal outcome still acks; late rejection is sanitized, not unhandled", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    let rejectGate!: (e: unknown) => void;
    const gate = new Promise<void>((_, rej) => {
      rejectGate = rej;
    });
    try {
      const bot = {
        postAnnouncement: async () => botFail({ retryable: false, code: "action_not_allowed" }),
      } as unknown as BotClient;
      const base = memLedger();
      const ledger = {
        ...base,
        failed: async (id: string, kind: string, key: string | null, reason: string) => {
          if (id === "j1") {
            await gate;
            return;
          }
          return base.failed(id, kind, key, reason);
        },
      };
      const ann = (jobId: string) => ({
        kind: "announcement",
        idempotencyKey: `k-${jobId}`,
        action: { channelKey: "c", body: "b" },
        jobId,
      });
      const m1 = msg(ann("j1"), 1);
      const m2 = msg(ann("j2"), 1);
      let m1Acks = 0;
      const origAck = m1.ack.bind(m1);
      m1.ack = () => {
        m1Acks += 1;
        return origAck();
      };
      const p = consume({ messages: [m1, m2] }, { bot, events: store(), lock: memLock(), ledger });
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(m1.acked).toBe(true);
      expect(m1.retried).toBeUndefined();
      expect(m2.acked).toBe(true);
      expectSanitizedTimeoutWarn(warn, "failed");
      rejectGate(new Error("late boom"));
      await vi.advanceTimersByTimeAsync(0);
      expect(m1Acks).toBe(1);
      const calls = ledgerWarns(warn, "failed");
      expect(calls.length).toBe(2);
      for (const c of calls) {
        expect(c[1]).toEqual({ exception: "Error" });
        expect(JSON.stringify(c)).not.toContain("late boom");
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      warn.mockRestore();
      err.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a hung dequeued on success still acks and runs the batch; late resolve is inert", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    try {
      const bot = {
        upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
      } as unknown as BotClient;
      const base = memLedger();
      const dequeuedFor: string[] = [];
      const ledger = {
        ...base,
        dequeued: async (id: string) => {
          if (id === "j1") {
            dequeuedFor.push(id);
            await gate;
            return;
          }
          return base.dequeued(id);
        },
      };
      const m1 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k1", jobId: "j1" }, 1);
      const m2 = msg({ kind: "sync-event", eventKey: "e2", idempotencyKey: "k2", jobId: "j2" }, 1);
      let m1Acks = 0;
      const origAck = m1.ack.bind(m1);
      m1.ack = () => {
        m1Acks += 1;
        return origAck();
      };
      const p = consume({ messages: [m1, m2] }, { bot, events: store(), lock: memLock(), ledger });
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(m1.acked).toBe(true);
      expect(m2.acked).toBe(true);
      expect(dequeuedFor).toEqual(["j1"]);
      expectSanitizedTimeoutWarn(warn, "dequeued");
      const ledgerWarnsBefore = ledgerWarns(warn, "dequeued").length;
      resolveGate();
      await vi.advanceTimersByTimeAsync(0);
      expect(m1Acks).toBe(1);
      expect(m1.acked).toBe(true);
      expect(ledgerWarns(warn, "dequeued").length).toBe(ledgerWarnsBefore);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a hung dequeued on success still acks; late rejection is sanitized, not unhandled", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    let rejectGate!: (e: unknown) => void;
    const gate = new Promise<void>((_, rej) => {
      rejectGate = rej;
    });
    try {
      const bot = {
        upsertEvent: async () => ({ ok: true, requestId: null, discordEventId: "d1" }),
      } as unknown as BotClient;
      const base = memLedger();
      const ledger = {
        ...base,
        dequeued: async (id: string) => {
          if (id === "j1") {
            await gate;
            return;
          }
          return base.dequeued(id);
        },
      };
      const m1 = msg({ kind: "sync-event", eventKey: "e1", idempotencyKey: "k1", jobId: "j1" }, 1);
      const m2 = msg({ kind: "sync-event", eventKey: "e2", idempotencyKey: "k2", jobId: "j2" }, 1);
      let m1Acks = 0;
      const origAck = m1.ack.bind(m1);
      m1.ack = () => {
        m1Acks += 1;
        return origAck();
      };
      const p = consume({ messages: [m1, m2] }, { bot, events: store(), lock: memLock(), ledger });
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(m1.acked).toBe(true);
      expect(m2.acked).toBe(true);
      expectSanitizedTimeoutWarn(warn, "dequeued");
      rejectGate(new Error("late boom"));
      await vi.advanceTimersByTimeAsync(0);
      expect(m1Acks).toBe(1);
      const calls = ledgerWarns(warn, "dequeued");
      expect(calls.length).toBe(2);
      for (const c of calls) {
        expect(c[1]).toEqual({ exception: "Error" });
        expect(JSON.stringify(c)).not.toContain("late boom");
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
