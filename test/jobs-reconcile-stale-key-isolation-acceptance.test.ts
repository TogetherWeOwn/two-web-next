import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileEvents } from "../src/jobs/cron";
import { uniqueKey } from "../src/jobs/sync-event";
import type { EventStore, UniqueLock } from "../src/jobs/types";

// Acceptance contract (acceptance-owned; the implementation change must not
// edit this file): one bad stale key is counted and skipped instead of
// starving the reconcile pass.
//
// Per stale key, the work that can throw today is the `pendingSync` read and
// the dispatch. A throw for one key must be:
//   - caught per key, so the pass resolves and later keys are still attempted
//     in order (no key is dropped, added, reordered or retried in-pass);
//   - logged once per failed key on `console.warn`, class-only: the bounded
//     exception class name, never the exception message, SQL, event keys or
//     any other thrown content. A skipped key is not a failed pass, so it
//     never writes to `console.error`;
//   - counted in a new `failed` field on the pass result (and on the single
//     "Event reconcile pass completed." info object when that line fires).
// `resynced` keeps its current meaning for keys whose per-key work completes
// without throwing — including a dispatch the unique lock absorbs, which is
// not a failure — so in these fixtures resynced + failed equals the number
// of stale keys attempted. `closed` and `materialized` are unchanged, and
// the pass info line also fires when `failed` is the only non-zero count.
// Throws outside the per-key loop (close, materialize, the stale-key read)
// still reject the pass exactly as today. Hermetic fakes only; no database.

const NOW = new Date("2026-10-02T12:00:00Z");
const SECRET = "test-marker-not-a-credential";

class SyntheticPendingError extends Error {}
class SyntheticDispatchError extends Error {}
class SyntheticStaleReadError extends Error {}

type StoreOptions = {
  stale?: string[];
  closed?: number;
  materialized?: number;
  pendingSync?: EventStore["pendingSync"];
  staleEventKeys?: EventStore["staleEventKeys"];
};

function fakeStore(opts: StoreOptions = {}): EventStore & {
  calls: string[];
  pendingAttempts: string[];
} {
  const calls: string[] = [];
  const pendingAttempts: string[] = [];
  const pendingSync = opts.pendingSync ?? (async () => null);
  return {
    calls,
    pendingAttempts,
    prepareSync: async () => null,
    completeSync: async () => {},
    claimSync: async () => null,
    deferSync: async () => {},
    failSync: async () => {},
    needsSync: async () => false,
    pendingSync: async (eventKey) => {
      pendingAttempts.push(eventKey);
      return pendingSync(eventKey);
    },
    closeFinished: async () => (calls.push("close"), opts.closed ?? 0),
    materializeSeries: async () => (calls.push("materialize"), opts.materialized ?? 0),
    staleEventKeys:
      opts.staleEventKeys ?? (async () => (calls.push("stale"), [...(opts.stale ?? [])])),
  };
}

function fakeQueue(failKeys: string[] = []) {
  const sent: { eventKey: string }[] = [];
  const failing = new Set(failKeys);
  return {
    sent,
    send: async (body: unknown) => {
      const message = body as { eventKey: string };
      if (failing.has(message.eventKey))
        throw new SyntheticDispatchError(`dispatch down for ${message.eventKey} ${SECRET}`);
      sent.push(message);
    },
  };
}

/** In-memory lock; `held` keys model a still-queued write-back that absorbs the dispatch. */
function fakeLock(held: string[] = []): UniqueLock & { acquired: string[] } {
  const locked = new Set(held);
  const acquired: string[] = [];
  return {
    acquired,
    acquire: async (k) => (
      acquired.push(k), locked.has(k) ? null : (locked.add(k), crypto.randomUUID())
    ),
    release: async (k) => void locked.delete(k),
  };
}

/** Serialize a log call the way a log stream would render it, Errors included. */
function render(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
      return JSON.stringify(arg, (_key, value: unknown) =>
        value instanceof Error ? `${value.name}: ${value.message}` : value,
      );
    })
    .join(" ");
}

function captureLogs() {
  const info: unknown[][] = [];
  const warn: string[] = [];
  const error: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => void info.push(args));
  vi.spyOn(console, "warn").mockImplementation(
    (...args: unknown[]) => void warn.push(render(args)),
  );
  vi.spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => void error.push(render(args)),
  );
  return { info, warn, error };
}

function passLog(info: unknown[][]): unknown[][] {
  return info.filter((args) => args[0] === "Event reconcile pass completed.");
}

function expectWarnClean(warn: string[], eventKeys: string[]): void {
  for (const line of warn) {
    expect(line).not.toContain(SECRET);
    for (const key of eventKeys) expect(line).not.toContain(key);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("reconcileEvents stale-key isolation (acceptance)", () => {
  it("a pendingSync throw on stale key 1 of 3 is counted and skipped; keys 2-3 still dispatch in order", async () => {
    const logs = captureLogs();
    const keys = ["stale-alpha", "stale-beta", "stale-gamma"];
    const events = fakeStore({
      stale: keys,
      closed: 2,
      materialized: 1,
      pendingSync: async (eventKey) => {
        if (eventKey === "stale-alpha")
          throw new SyntheticPendingError(`pending read down for ${eventKey} ${SECRET}`);
        return null;
      },
    });
    const queue = fakeQueue();

    const r = await reconcileEvents({ events, queue, lock: fakeLock(), now: () => NOW });

    expect(events.calls).toEqual(["close", "materialize", "stale"]);
    expect(events.pendingAttempts).toEqual(keys);
    expect(queue.sent.map((b) => b.eventKey)).toEqual(["stale-beta", "stale-gamma"]);
    expect(r).toEqual({ closed: 2, materialized: 1, resynced: 2, failed: 1 });
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain("SyntheticPendingError");
    expectWarnClean(logs.warn, keys);
    expect(logs.error).toEqual([]);
    expect(passLog(logs.info)).toEqual([
      [
        "Event reconcile pass completed.",
        expect.objectContaining({ closed: 2, materialized: 1, resynced: 2, failed: 1 }),
      ],
    ]);
  });

  it("a dispatch throw on the middle stale key is counted and skipped; the keys around it still dispatch", async () => {
    const logs = captureLogs();
    const keys = ["stale-one", "stale-two", "stale-three"];
    const events = fakeStore({ stale: keys });
    const queue = fakeQueue(["stale-two"]);
    const lock = fakeLock();

    const r = await reconcileEvents({ events, queue, lock, now: () => NOW });

    expect(events.pendingAttempts).toEqual(keys);
    expect(lock.acquired).toEqual(keys.map((k) => uniqueKey(k)));
    expect(queue.sent.map((b) => b.eventKey)).toEqual(["stale-one", "stale-three"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2, failed: 1 });
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain("SyntheticDispatchError");
    expectWarnClean(logs.warn, keys);
    expect(logs.error).toEqual([]);
  });

  it("counts every failed key: two throws among four stale keys report failed 2 and warn twice", async () => {
    const logs = captureLogs();
    const keys = ["fail-a", "ok-b", "fail-c", "ok-d"];
    const events = fakeStore({
      stale: keys,
      pendingSync: async (eventKey) => {
        if (eventKey.startsWith("fail-"))
          throw new SyntheticPendingError(`pending read down ${SECRET}`);
        return null;
      },
    });
    const queue = fakeQueue();

    const r = await reconcileEvents({ events, queue, lock: fakeLock(), now: () => NOW });

    expect(events.pendingAttempts).toEqual(keys);
    expect(queue.sent.map((b) => b.eventKey)).toEqual(["ok-b", "ok-d"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2, failed: 2 });
    expect(logs.warn).toHaveLength(2);
    for (const line of logs.warn) expect(line).toContain("SyntheticPendingError");
    expectWarnClean(logs.warn, keys);
    expect(logs.error).toEqual([]);
  });

  it("a non-Error pendingSync rejection is counted, skipped, and never logged verbatim", async () => {
    const logs = captureLogs();
    const keys = ["bad-rejection", "survivor-key"];
    const events = fakeStore({
      stale: keys,
      pendingSync: async (eventKey) => {
        if (eventKey === "bad-rejection") throw `pending read down ${SECRET}`;
        return null;
      },
    });
    const queue = fakeQueue();

    const r = await reconcileEvents({ events, queue, lock: fakeLock(), now: () => NOW });

    expect(queue.sent.map((b) => b.eventKey)).toEqual(["survivor-key"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 1, failed: 1 });
    expect(logs.warn).toHaveLength(1);
    expectWarnClean(logs.warn, keys);
    expect(logs.error).toEqual([]);
  });

  it("a pass whose only stale key fails still completes, reports failed 1, and logs the pass once", async () => {
    const logs = captureLogs();
    const events = fakeStore({
      stale: ["only-bad-key"],
      pendingSync: async () => {
        throw new SyntheticPendingError(`pending read down ${SECRET}`);
      },
    });
    const queue = fakeQueue();

    const r = await reconcileEvents({ events, queue, lock: fakeLock(), now: () => NOW });

    expect(queue.sent).toEqual([]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 0, failed: 1 });
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain("SyntheticPendingError");
    expectWarnClean(logs.warn, ["only-bad-key"]);
    expect(logs.error).toEqual([]);
    expect(passLog(logs.info)).toEqual([
      ["Event reconcile pass completed.", expect.objectContaining({ failed: 1 })],
    ]);
  });

  it("clean pass control: every stale key dispatches, failed is 0, and nothing warns", async () => {
    const logs = captureLogs();
    const keys = ["clean-a", "clean-b", "clean-c"];
    const events = fakeStore({ stale: keys });
    const queue = fakeQueue();

    const r = await reconcileEvents({ events, queue, lock: fakeLock(), now: () => NOW });

    expect(queue.sent.map((b) => b.eventKey)).toEqual(keys);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 3, failed: 0 });
    expect(logs.warn).toEqual([]);
    expect(logs.error).toEqual([]);
    expect(passLog(logs.info)).toEqual([
      [
        "Event reconcile pass completed.",
        expect.objectContaining({ closed: 0, materialized: 0, resynced: 3, failed: 0 }),
      ],
    ]);
  });

  it("absorbed-dispatch control: a lock-absorbed key still counts resynced, never failed, and does not warn", async () => {
    const logs = captureLogs();
    const keys = ["absorbed-key", "sent-key"];
    const events = fakeStore({ stale: keys });
    const queue = fakeQueue();
    const lock = fakeLock([uniqueKey("absorbed-key")]);

    const r = await reconcileEvents({ events, queue, lock, now: () => NOW });

    expect(queue.sent.map((b) => b.eventKey)).toEqual(["sent-key"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2, failed: 0 });
    expect(logs.warn).toEqual([]);
    expect(logs.error).toEqual([]);
  });

  it("empty pass control: no stale keys returns zeros including failed, with no pass log and no warnings", async () => {
    const logs = captureLogs();
    const queue = fakeQueue();

    const r = await reconcileEvents({
      events: fakeStore({ stale: [] }),
      queue,
      lock: fakeLock(),
      now: () => NOW,
    });

    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 0, failed: 0 });
    expect(queue.sent).toEqual([]);
    expect(passLog(logs.info)).toEqual([]);
    expect(logs.warn).toEqual([]);
    expect(logs.error).toEqual([]);
  });

  it("outer-failure control: a stale-key read throw still rejects the pass and dispatches nothing", async () => {
    const logs = captureLogs();
    const failure = new SyntheticStaleReadError(`stale read down ${SECRET}`);
    const events = fakeStore({
      staleEventKeys: async () => {
        throw failure;
      },
    });
    const queue = fakeQueue();

    await expect(reconcileEvents({ events, queue, lock: fakeLock(), now: () => NOW })).rejects.toBe(
      failure,
    );

    expect(queue.sent).toEqual([]);
    expect(passLog(logs.info)).toEqual([]);
  });
});
