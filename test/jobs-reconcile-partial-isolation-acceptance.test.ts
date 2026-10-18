import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_EVENT } from "../src/jobs/constants";
import { reconcileEvents } from "../src/jobs/cron";
import { uniqueKey } from "../src/jobs/sync-event";
import type { EventStore, SyncAttempt, UniqueLock } from "../src/jobs/types";

// Acceptance pins (acceptance-owned; the implementation change must not edit
// this file): the counts the scheduled wrapper pages on come from a pass
// that keeps isolating poison keys without aborting healthy ones, and the
// page itself belongs to the scheduled wrapper — a direct reconcileEvents
// call never emits a scheduled.failing line.
//
// Contract under test, against the real reconcileEvents with hermetic fakes
// (no DB, no queue, no Discord):
// - A single failed key and a mixed pass RESOLVE with failed > 0; every
//   healthy key is still dispatched in the same pass, in order, and a
//   failed send releases its own lease (poison-key isolation preserved).
// - Direct calls emit no console.error line at all, partial or healthy:
//   paging after a resolved scheduled pass is the wrapper's job (pinned in
//   jobs-reconcile-partial-failure-paging-acceptance.test.ts), so the new
//   signal cannot double-page or fire for non-scheduled callers.
// - A fully failed multi-key pass keeps rejecting (the existing
//   all-failed throw path the wrapper already pages once), with the
//   original first error.
// - Healthy and skipped (not-yet-due) passes resolve with failed 0 and
//   stay silent on console.error.
// - No raw exception message (which may carry bound values or an event
//   key) reaches console.error.

const NOW = new Date("2026-10-02T12:00:00Z");
const SECRET_FRAGMENT = "synthetic-secret-value";

class PoisonSendError extends Error {}

type Harness = {
  events: EventStore;
  queue: {
    sent: string[];
    send: (body: unknown, opts?: { delaySeconds?: number }) => Promise<void>;
  };
  lock: UniqueLock & { released: string[]; heldNow: () => string[] };
};

function harness(
  opts: { stale?: string[]; throwOnSend?: string[]; futurePending?: string[] } = {},
): Harness {
  const sent: string[] = [];
  const locked = new Set<string>();
  const released: string[] = [];

  const events: EventStore = {
    prepareSync: async () => null,
    completeSync: async () => {},
    claimSync: async () => null,
    deferSync: async () => {},
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async (key) => {
      if (!(opts.futurePending ?? []).includes(key)) return null;
      const attempt: SyncAttempt = {
        idempotencyKey: `idem-${key}`,
        eventKey: key,
        revision: 1,
        mirroredAt: NOW,
        state: "pending",
        requestAttempts: 1,
        nextAttemptAt: new Date(NOW.getTime() + 3_600_000),
        action: "event.cancel",
        payload: { eventKey: key },
      };
      return attempt;
    },
    closeFinished: async () => 0,
    materializeSeries: async () => 0,
    staleEventKeys: async () => [...(opts.stale ?? [])],
  };

  const queue: Harness["queue"] = {
    sent,
    send: async (body) => {
      const b = body as { eventKey: string };
      if ((opts.throwOnSend ?? []).includes(b.eventKey))
        throw new PoisonSendError(`poison send for ${b.eventKey}: ${SECRET_FRAGMENT}`);
      sent.push(b.eventKey);
    },
  };

  const lock: Harness["lock"] = {
    released,
    heldNow: () => [...locked],
    acquire: async (k) => (locked.has(k) ? null : (locked.add(k), crypto.randomUUID())),
    release: async (k) => (released.push(k), void locked.delete(k)),
  };

  return { events, queue, lock };
}

let errorCalls: unknown[][] = [];

beforeEach(() => {
  errorCalls = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorCalls.push(args);
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

function run(h: Harness) {
  return reconcileEvents({ events: h.events, queue: h.queue, lock: h.lock, now: () => NOW });
}

function expectNoErrorLines(): void {
  expect(errorCalls).toEqual([]);
  const text = JSON.stringify(errorCalls);
  expect(text).not.toContain(SECRET_FRAGMENT);
  expect(text).not.toContain("scheduled.failing");
}

describe("reconcile partial isolation behind the page signal (acceptance, no DB)", () => {
  it("a single failed key resolves with failed 1 and the direct call pages nothing", async () => {
    const h = harness({ stale: ["poison"], throwOnSend: ["poison"] });

    const r = await run(h);

    expect(h.queue.sent).toEqual([]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 0, absorbed: 0, failed: 1 });
    expect(h.lock.released).toContain(uniqueKey("poison"));
    expect(h.lock.heldNow()).not.toContain(uniqueKey("poison"));
    expectNoErrorLines();
  });

  it("a mixed pass preserves every healthy dispatch around the poison key and resolves", async () => {
    const h = harness({ stale: ["ok1", "poison", "ok2"], throwOnSend: ["poison"] });

    const r = await run(h);

    expect(h.queue.sent).toEqual(["ok1", "ok2"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2, absorbed: 0, failed: 1 });
    expectNoErrorLines();
  });

  it("a healthy pass resolves with failed 0 and stays silent on console.error", async () => {
    const h = harness({ stale: ["ok1", "ok2"] });

    const r = await run(h);

    expect(h.queue.sent).toEqual(["ok1", "ok2"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2, absorbed: 0, failed: 0 });
    expectNoErrorLines();
  });

  it("a skipped not-yet-due pass resolves all-zero and stays silent on console.error", async () => {
    const h = harness({ stale: ["future"], futurePending: ["future"] });

    const r = await run(h);

    expect(h.queue.sent).toEqual([]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 0, absorbed: 0, failed: 0 });
    expect(SYNC_EVENT.tries).toBeGreaterThan(1);
    expectNoErrorLines();
  });

  it("a fully failed multi-key pass still rejects with the first error (existing throw path)", async () => {
    const h = harness({ stale: ["poison1", "poison2"], throwOnSend: ["poison1", "poison2"] });

    await expect(run(h)).rejects.toBeInstanceOf(PoisonSendError);
    await expect(
      run(harness({ stale: ["poison1", "poison2"], throwOnSend: ["poison1", "poison2"] })),
    ).rejects.toThrow("poison send for poison1");

    expect(h.queue.sent).toEqual([]);
    expectNoErrorLines();
  });
});
