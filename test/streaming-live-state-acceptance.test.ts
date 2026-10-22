import { describe, expect, it, vi } from "vitest";
import { createLiveStateReader } from "../src/streaming/live-state";

// Test-first boundary: the production reader owns caching; only the upstream
// status read and clock are fixtures. The Builder supplies this module.
const LIVE = { live: true, sessionId: "broadcast-a" };
const OFFLINE = { live: false, sessionId: null };

function fixture(initial = LIVE as typeof LIVE | typeof OFFLINE) {
  let time = 0;
  let status = initial;
  const calls: string[] = [];
  const read = createLiveStateReader({
    now: () => time,
    readStatus: async (inputUid: string) => {
      calls.push(inputUid);
      return { ...status };
    },
  });
  return {
    read,
    calls,
    at: (value: number) => {
      time = value;
    },
    upstream: (value: typeof LIVE | typeof OFFLINE) => {
      status = value;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("streaming live-state cache: 60-second display-only freshness", () => {
  it("reads on the first request, then serves a burst without per-viewer upstream calls", async () => {
    const f = fixture();
    expect(await f.read("input-a")).toMatchObject(LIVE);
    const burst = await Promise.all(Array.from({ length: 20 }, () => f.read("input-a")));
    expect(burst).toHaveLength(20);
    for (const value of burst) expect(value).toMatchObject(LIVE);
    expect(f.calls).toEqual(["input-a"]);
  });

  it("keeps the cached live state at 59,999ms, then observes offline at exactly 60,000ms", async () => {
    const f = fixture();
    expect(await f.read("input-a")).toMatchObject(LIVE);
    f.upstream(OFFLINE);
    f.at(59_999);
    expect(await f.read("input-a")).toMatchObject(LIVE);
    expect(f.calls).toEqual(["input-a"]);
    f.at(60_000);
    expect(await f.read("input-a")).toMatchObject(OFFLINE);
    expect(f.calls).toEqual(["input-a", "input-a"]);
  });

  it("caches offline too, but discovers the next broadcast when that TTL expires", async () => {
    const f = fixture(OFFLINE);
    expect(await f.read("input-a")).toMatchObject(OFFLINE);
    f.upstream(LIVE);
    f.at(30_000);
    expect(await f.read("input-a")).toMatchObject(OFFLINE);
    f.at(60_000);
    expect(await f.read("input-a")).toMatchObject(LIVE);
    expect(f.calls).toEqual(["input-a", "input-a"]);
  });

  it("does not renew freshness when viewers keep hitting the cached page", async () => {
    const f = fixture();
    await f.read("input-a");
    for (const time of [20_000, 40_000, 59_999]) {
      f.at(time);
      expect(await f.read("input-a")).toMatchObject(LIVE);
    }
    f.upstream(OFFLINE);
    f.at(60_000);
    expect(await f.read("input-a")).toMatchObject(OFFLINE);
    expect(f.calls).toEqual(["input-a", "input-a"]);
  });

  it("keeps different members' input states and expiry times separate", async () => {
    const f = fixture();
    expect(await f.read("input-a")).toMatchObject(LIVE);
    f.upstream(OFFLINE);
    f.at(10_000);
    expect(await f.read("input-b")).toMatchObject(OFFLINE);
    f.at(60_000);
    f.upstream({ live: true, sessionId: "broadcast-next" });
    expect(await f.read("input-a")).toMatchObject({ live: true, sessionId: "broadcast-next" });
    expect(await f.read("input-b")).toMatchObject(OFFLINE);
    expect(f.calls).toEqual(["input-a", "input-b", "input-a"]);
  });

  it("coalesces concurrent cold requests instead of charging an upstream read per viewer", async () => {
    const gate = deferred<typeof LIVE>();
    let calls = 0;
    const read = createLiveStateReader({
      now: () => 0,
      readStatus: async () => {
        calls++;
        return gate.promise;
      },
    });
    const waiting = Array.from({ length: 12 }, () => read("input-a"));
    try {
      await vi.waitUntil(() => calls > 0);
      expect(calls).toBe(1);
    } finally {
      gate.resolve(LIVE);
      await Promise.allSettled(waiting);
    }
    const results = await Promise.all(waiting);
    expect(results).toHaveLength(12);
    for (const result of results) expect(result).toMatchObject(LIVE);
    expect(calls).toBe(1);
  });

  it("does not keep a rejected refresh in flight or silently renew stale LIVE forever", async () => {
    let time = 0;
    let calls = 0;
    const read = createLiveStateReader({
      now: () => time,
      readStatus: async () => {
        calls++;
        if (calls === 2) throw new Error("synthetic status outage");
        return calls === 1 ? LIVE : OFFLINE;
      },
    });
    expect(await read("input-a")).toMatchObject(LIVE);
    time = 60_000;
    await expect(read("input-a")).rejects.toThrow("synthetic status outage");
    expect(await read("input-a")).toMatchObject(OFFLINE);
    expect(calls).toBe(3);
  });
});
