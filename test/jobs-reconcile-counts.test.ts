import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYNC_EVENT } from "../src/jobs/constants";
import { reconcileEvents } from "../src/jobs/cron";
import { uniqueKey } from "../src/jobs/sync-event";
import type { EventStore, SyncAttempt, UniqueLock } from "../src/jobs/types";

// Acceptance pins (failing-first): honest reconcile counts and poison-key isolation.
//
// Contract under test:
// - `resynced` counts only dispatches the transport accepted (queue.send resolved
//   after the unique lock was acquired). A stale row is not a dispatch.
// - Dispatches the unique lock absorbs (a still-queued write-back holds the key)
//   are reported separately as `absorbed`, in the return value and the pass log.
// - One throwing key is isolated per key: it counts as `failed`, the pass still
//   resolves, and every remaining stale key reconciles in the same pass. The
//   per-key boundary covers the whole key body (pending lookup + dispatch), so a
//   key whose lookup throws starves nobody either.
// - Due/budget/exhaustion skip rules are unchanged: skipped keys count in none
//   of resynced/absorbed/failed and never touch the lock or the queue. A due
//   pending request still dispatches under its original idempotency key.
// - The completed-pass log keeps its message and fires exactly once whenever
//   any count is non-zero (including absorbed-only and failed-only passes, so
//   the new evidence reaches the scheduler logs and is not silently dropped);
//   a fully empty pass stays silent.
// - closed/materialized pass through unchanged; ordering close -> materialize
//   -> stale is unchanged.

const NOW = new Date("2026-10-02T12:00:00Z");
const hour = 3_600_000;

type PendingSpec = { requestAttempts: number; nextAttemptAt: Date | null; idempotencyKey: string };

function pendingAttempt(key: string, spec: PendingSpec): SyncAttempt {
  return {
    idempotencyKey: spec.idempotencyKey,
    eventKey: key,
    revision: 1,
    mirroredAt: NOW,
    state: "pending",
    requestAttempts: spec.requestAttempts,
    nextAttemptAt: spec.nextAttemptAt,
    action: "event.cancel",
    payload: { eventKey: key },
  };
}

type Harness = {
  events: EventStore & { calls: string[]; pendingLookups: string[] };
  queue: {
    sent: { eventKey: string; idempotencyKey: string }[];
    send: (body: unknown, opts?: { delaySeconds?: number }) => Promise<void>;
  };
  lock: UniqueLock & { acquired: string[]; released: string[]; heldNow: () => string[] };
};

function harness(
  opts: {
    stale?: string[];
    closed?: number;
    materialized?: number;
    heldLocks?: string[]; // unique keys already held -> dispatch is absorbed
    throwOnSend?: string[]; // event keys whose queue.send throws
    throwOnPending?: string[]; // event keys whose pendingSync throws
    pending?: Record<string, PendingSpec>;
  } = {},
): Harness {
  const calls: string[] = [];
  const pendingLookups: string[] = [];
  const sent: Harness["queue"]["sent"] = [];
  const locked = new Set(opts.heldLocks ?? []);
  const acquired: string[] = [];
  const released: string[] = [];

  const events: Harness["events"] = {
    calls,
    pendingLookups,
    prepareSync: async () => null,
    completeSync: async () => {},
    claimSync: async () => null,
    deferSync: async () => {},
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async (key) => {
      pendingLookups.push(key);
      if ((opts.throwOnPending ?? []).includes(key)) throw new Error(`poison lookup: ${key}`);
      const spec = opts.pending?.[key];
      return spec ? pendingAttempt(key, spec) : null;
    },
    closeFinished: async () => (calls.push("close"), opts.closed ?? 0),
    materializeSeries: async () => (calls.push("materialize"), opts.materialized ?? 0),
    staleEventKeys: async () => (calls.push("stale"), [...(opts.stale ?? [])]),
  };

  const queue: Harness["queue"] = {
    sent,
    send: async (body) => {
      const b = body as { eventKey: string; idempotencyKey: string };
      if ((opts.throwOnSend ?? []).includes(b.eventKey))
        throw new Error(`poison send: ${b.eventKey}`);
      sent.push(b);
    },
  };

  const lock: Harness["lock"] = {
    acquired,
    released,
    heldNow: () => [...locked],
    acquire: async (k) => (
      acquired.push(k), locked.has(k) ? null : (locked.add(k), crypto.randomUUID())
    ),
    release: async (k) => (released.push(k), void locked.delete(k)),
  };

  return { events, queue, lock };
}

function run(h: Harness) {
  return reconcileEvents({ events: h.events, queue: h.queue, lock: h.lock, now: () => NOW });
}

afterEach(() => vi.restoreAllMocks());

describe("reconcile counts: accepted vs absorbed (no DB)", () => {
  it("counts only transport-accepted dispatches as resynced and reports absorbed separately", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({ stale: ["a", "queued", "c"], heldLocks: [uniqueKey("queued")] });

    const r = await run(h);

    expect(h.queue.sent.map((b) => b.eventKey)).toEqual(["a", "c"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2, absorbed: 1, failed: 0 });
  });

  it("reports resynced 0 when every dispatch is absorbed, and still logs the pass once", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({ stale: ["a", "b"], heldLocks: [uniqueKey("a"), uniqueKey("b")] });

    const r = await run(h);

    expect(h.queue.sent).toEqual([]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 0, absorbed: 2, failed: 0 });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Event reconcile pass completed.", {
      closed: 0,
      materialized: 0,
      resynced: 0,
      absorbed: 2,
      failed: 0,
    });
  });
});

describe("reconcile counts: one poison key is isolated (no DB)", () => {
  it("a queue send that throws for the middle key: later keys still send in the same pass", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({ stale: ["ok1", "poison", "ok2"], throwOnSend: ["poison"] });

    const r = await run(h);

    expect(h.queue.sent.map((b) => b.eventKey)).toEqual(["ok1", "ok2"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2, absorbed: 0, failed: 1 });
    // The failed send compensated its own lease; the poison key is not left held.
    expect(h.lock.released).toContain(uniqueKey("poison"));
    expect(h.lock.heldNow()).not.toContain(uniqueKey("poison"));
  });

  it("a throwing first key starves nobody", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({ stale: ["poison", "ok1", "ok2"], throwOnSend: ["poison"] });

    const r = await run(h);

    expect(h.queue.sent.map((b) => b.eventKey)).toEqual(["ok1", "ok2"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2, absorbed: 0, failed: 1 });
  });

  it("a key whose pending lookup throws is isolated before any lock or send for that key", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({ stale: ["ok1", "poison", "ok2"], throwOnPending: ["poison"] });

    const r = await run(h);

    expect(h.queue.sent.map((b) => b.eventKey)).toEqual(["ok1", "ok2"]);
    expect(h.lock.acquired).not.toContain(uniqueKey("poison"));
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2, absorbed: 0, failed: 1 });
  });

  it("a failed-only pass resolves and logs its failure count once", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({ stale: ["poison"], throwOnSend: ["poison"] });

    const r = await run(h);

    expect(h.queue.sent).toEqual([]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 0, absorbed: 0, failed: 1 });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Event reconcile pass completed.", {
      closed: 0,
      materialized: 0,
      resynced: 0,
      absorbed: 0,
      failed: 1,
    });
  });
});

describe("reconcile counts: skip rules unchanged (no DB)", () => {
  it("exhausted, unsettled and not-yet-due pending requests are skipped: no lock, no send, no count", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({
      stale: ["exhausted", "unsettled", "future"],
      pending: {
        exhausted: {
          requestAttempts: SYNC_EVENT.tries,
          nextAttemptAt: new Date(NOW.getTime() - hour),
          idempotencyKey: "idem-exhausted",
        },
        unsettled: { requestAttempts: 1, nextAttemptAt: null, idempotencyKey: "idem-unsettled" },
        future: {
          requestAttempts: 1,
          nextAttemptAt: new Date(NOW.getTime() + hour),
          idempotencyKey: "idem-future",
        },
      },
    });

    const r = await run(h);

    expect(h.events.pendingLookups).toEqual(["exhausted", "unsettled", "future"]);
    expect(h.lock.acquired).toEqual([]);
    expect(h.queue.sent).toEqual([]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 0, absorbed: 0, failed: 0 });
  });

  it("a due pending request with budget left dispatches under its original idempotency key", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({
      stale: ["due"],
      pending: {
        // Attempts one below the cap and due exactly now: both boundaries admit.
        due: {
          requestAttempts: SYNC_EVENT.tries - 1,
          nextAttemptAt: NOW,
          idempotencyKey: "idem-due",
        },
      },
    });

    const r = await run(h);

    expect(h.queue.sent).toEqual([
      {
        eventKey: "due",
        idempotencyKey: "idem-due",
        kind: "sync-event",
        leaseToken: expect.any(String),
        requestId: undefined,
      },
    ]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 1, absorbed: 0, failed: 0 });
  });
});

describe("reconcile counts: pass shape (no DB)", () => {
  it("mixed pass: ordering and closed/materialized passthrough unchanged, every stale key accounted once", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({
      closed: 2,
      materialized: 1,
      stale: ["sent1", "held", "poison", "future", "sent2"],
      heldLocks: [uniqueKey("held")],
      throwOnSend: ["poison"],
      pending: {
        future: {
          requestAttempts: 0,
          nextAttemptAt: new Date(NOW.getTime() + hour),
          idempotencyKey: "idem-future2",
        },
      },
    });

    const r = await run(h);

    expect(h.events.calls).toEqual(["close", "materialize", "stale"]);
    expect(h.queue.sent.map((b) => b.eventKey)).toEqual(["sent1", "sent2"]);
    // 5 stale keys = 2 accepted + 1 absorbed + 1 failed + 1 skipped.
    expect(r).toEqual({ closed: 2, materialized: 1, resynced: 2, absorbed: 1, failed: 1 });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Event reconcile pass completed.", {
      closed: 2,
      materialized: 1,
      resynced: 2,
      absorbed: 1,
      failed: 1,
    });
  });

  it("a fully empty pass returns zeros and stays silent", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness({ stale: [] });

    const r = await run(h);

    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 0, absorbed: 0, failed: 0 });
    expect(info).not.toHaveBeenCalled();
    expect(h.lock.acquired).toEqual([]);
    expect(h.queue.sent).toEqual([]);
  });

  it("the stale-rows counting comment is gone from the reconcile source", () => {
    const src = readFileSync("src/jobs/cron.ts", "utf8");
    expect(src).not.toContain("counts stale rows");
    expect(src).not.toContain("not accepted dispatches");
  });
});
