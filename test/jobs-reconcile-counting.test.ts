import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileEvents } from "../src/jobs/cron";
import { uniqueKey } from "../src/jobs/sync-event";
import type { EventStore, UniqueLock } from "../src/jobs/types";

// DB-free pins for the two Laravel-parity rules in reconcileEvents: close-finished runs before the
// sync pass, and `resynced` counts stale rows rather than accepted dispatches.

type Row = { key: string; status: "draft" | "published" | "past"; endsAt: Date; discordEventId: string | null };

const NOW = new Date("2026-10-02T12:00:00Z");
const hour = 3_600_000;
const ended = new Date(NOW.getTime() - hour);
const upcoming = new Date(NOW.getTime() + hour);

/** Stateful fake mirroring the store contract: close flips published+ended to past; stale is published+unmirrored. */
function fakeEvents(rows: Row[]): EventStore & { calls: string[]; closedAt: Date[] } {
  const calls: string[] = [];
  const closedAt: Date[] = [];
  return {
    calls,
    closedAt,
    find: async () => null,
    recordMirrored: async () => {},
    closeFinished: async (now) => {
      calls.push("close");
      closedAt.push(now);
      const finished = rows.filter((r) => r.status === "published" && r.endsAt < now);
      for (const r of finished) r.status = "past";
      return finished.length;
    },
    materializeSeries: async () => (calls.push("materialize"), 0),
    staleEventKeys: async () => {
      calls.push("stale");
      return rows.filter((r) => r.status === "published" && r.discordEventId === null).map((r) => r.key);
    },
  };
}

function fakeQueue() {
  const sent: { eventKey: string }[] = [];
  return { sent, send: async (body: unknown) => void sent.push(body as { eventKey: string }) };
}

/** In-memory lock; `held` keys model a still-queued write-back that absorbs the dispatch. */
function fakeLock(held: string[] = []): UniqueLock & { acquired: string[] } {
  const locked = new Set(held);
  const acquired: string[] = [];
  return {
    acquired,
    acquire: async (k) => (acquired.push(k), locked.has(k) ? null : (locked.add(k), crypto.randomUUID())),
    release: async (k) => void locked.delete(k),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("reconcileEvents ordering and counting (no DB)", () => {
  it("closes an ended+stale event before the sync pass, counts it as closed, and never re-dispatches it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const rows: Row[] = [
      { key: "ended-stale", status: "published", endsAt: ended, discordEventId: null },
      { key: "live-stale", status: "published", endsAt: upcoming, discordEventId: null },
      { key: "live-synced", status: "published", endsAt: upcoming, discordEventId: "d1" },
    ];
    const events = fakeEvents(rows);
    const queue = fakeQueue();
    const lock = fakeLock();

    const r = await reconcileEvents({ events, queue, lock, now: () => NOW });

    expect(events.calls).toEqual(["close", "materialize", "stale"]);
    expect(events.closedAt).toEqual([NOW]);
    expect(rows.find((x) => x.key === "ended-stale")!.status).toBe("past");
    expect(r).toEqual({ closed: 1, materialized: 0, resynced: 1 });
    expect(queue.sent.map((b) => b.eventKey)).toEqual(["live-stale"]);
    expect(lock.acquired).not.toContain(uniqueKey("ended-stale"));
  });

  it("counts a stale row whose dispatch the unique lock absorbs", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const rows: Row[] = [
      { key: "queued", status: "published", endsAt: upcoming, discordEventId: null },
      { key: "fresh", status: "published", endsAt: upcoming, discordEventId: null },
    ];
    const queue = fakeQueue();
    const lock = fakeLock([uniqueKey("queued")]);

    const r = await reconcileEvents({ events: fakeEvents(rows), queue, lock, now: () => NOW });

    expect(lock.acquired).toEqual([uniqueKey("queued"), uniqueKey("fresh")]);
    expect(queue.sent.map((b) => b.eventKey)).toEqual(["fresh"]);
    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 2 });
  });

  it("counts every stale row even when every dispatch is absorbed", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const rows: Row[] = [
      { key: "a", status: "published", endsAt: upcoming, discordEventId: null },
      { key: "b", status: "published", endsAt: upcoming, discordEventId: null },
    ];
    const queue = fakeQueue();

    const r = await reconcileEvents({
      events: fakeEvents(rows),
      queue,
      lock: fakeLock([uniqueKey("a"), uniqueKey("b")]),
      now: () => NOW,
    });

    expect(queue.sent).toEqual([]);
    expect(r.resynced).toBe(2);
  });

  it("returns zeros with no log line, lock or send on an empty pass", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const rows: Row[] = [
      { key: "draft", status: "draft", endsAt: ended, discordEventId: null },
      { key: "synced", status: "published", endsAt: upcoming, discordEventId: "d1" },
    ];
    const queue = fakeQueue();
    const lock = fakeLock();

    const r = await reconcileEvents({ events: fakeEvents(rows), queue, lock, now: () => NOW });

    expect(r).toEqual({ closed: 0, materialized: 0, resynced: 0 });
    expect(info).not.toHaveBeenCalled();
    expect(lock.acquired).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("logs a non-empty pass exactly once with the counts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const rows: Row[] = [
      { key: "ended", status: "published", endsAt: ended, discordEventId: "d1" },
      { key: "stale", status: "published", endsAt: upcoming, discordEventId: null },
    ];

    await reconcileEvents({ events: fakeEvents(rows), queue: fakeQueue(), lock: fakeLock(), now: () => NOW });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Event reconcile pass completed.", { closed: 1, materialized: 0, resynced: 1 });
  });
});
