import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

const state = vi.hoisted(() => ({
  live: [] as Record<string, unknown>[],
  ranks: [] as Record<string, unknown>[],
  liveError: null as Error | null,
  ranksError: null as Error | null,
  delayMs: 0,
  queries: [] as string[],
  liveQueries: 0,
  ranksQueries: 0,
}));
vi.mock("postgres", () => ({
  default: () => {
    const sql = async (parts: TemplateStringsArray) => {
      const query = parts.join("");
      state.queries.push(query);
      const live = query.includes("web_v1.live_counts");
      if (live) state.liveQueries++;
      else state.ranksQueries++;
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      const error = live ? state.liveError : state.ranksError;
      if (error) throw error;
      return (live ? state.live : state.ranks).map((row) => ({ ...row }));
    };
    sql.end = async () => {};
    return sql;
  },
}));

const NOW = Date.parse("2026-09-30T12:00:00Z");
const env = { BOT_DB: { connectionString: "postgres://fixture.test/counts" } } as Env;
let counts: typeof import("../src/counts");
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.assign(state, {
    live: [{ human_member_count: "84", online_count: "12", counts_updated_at: new Date(NOW) }],
    ranks: [{ rank_key: "prospect", rank_label: "Prospect", member_count: "24" }],
    liveError: null,
    ranksError: null,
    delayMs: 0,
    queries: [],
    liveQueries: 0,
    ranksQueries: 0,
  });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  counts = await import("../src/counts");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// docs/web-v1-contract.md: cached snapshots keep their already-evaluated
// freshness until TTL expiry; there is no post-expiry stale fallback. These
// tests pin that the ten-minute age classification is evaluated once at fill
// time and never recomputed inside the warm-cache window.
describe("warm-cache freshness boundary", () => {
  it("pins a fresh classification past the age threshold until TTL expiry", async () => {
    // Fill when the snapshot is 9m59s old: fresh by one second.
    state.live[0]!.counts_updated_at = new Date(NOW - 599_000);
    expect((await counts.readCounts(env)).memberCount).toBe(84);
    expect(state.liveQueries).toBe(1);
    // At +59,999ms the snapshot's true age is ~11m and a reread would classify
    // it stale, but the cached value keeps its fill-time freshness with no reread.
    vi.setSystemTime(NOW + 59_999);
    expect((await counts.readCounts(env)).memberCount).toBe(84);
    expect(state.liveQueries).toBe(1);
    // Exactly at +60,000ms the cache expires: one reread reclassifies stale.
    vi.setSystemTime(NOW + 60_000);
    expect((await counts.readCounts(env)).memberCount).toBeNull();
    expect(state.liveQueries).toBe(2);
    // The newly cached stale outcome is itself pinned; no extra rereads.
    expect((await counts.readCounts(env)).memberCount).toBeNull();
    expect(state.liveQueries).toBe(2);
  });

  it("pins a stale classification for a future-dated snapshot until TTL expiry", async () => {
    // Carbon's diff is absolute: 1ms past the ten-minute bound in the FUTURE
    // is already stale at fill time.
    state.live[0]!.counts_updated_at = new Date(NOW + 600_001);
    expect((await counts.readCounts(env)).memberCount).toBeNull();
    expect(state.liveQueries).toBe(1);
    // Advancing the clock shrinks the absolute age below the bound, but the
    // warm cache keeps serving the fill-time stale outcome with no reread.
    vi.setSystemTime(NOW + 59_999);
    expect((await counts.readCounts(env)).memberCount).toBeNull();
    expect(state.liveQueries).toBe(1);
    // At expiry one reread sees the now-fresh absolute age and shows numerals.
    vi.setSystemTime(NOW + 60_000);
    expect((await counts.readCounts(env)).memberCount).toBe(84);
    expect(state.liveQueries).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps live and rank outcomes isolated across the shared TTL boundary", async () => {
    // Fill with the live view down: live caches its failure, ranks caches its
    // success. Neither contaminates the other inside the window.
    state.liveError = new Error("live view unavailable");
    expect(await counts.readCounts(env)).toMatchObject({
      memberCount: null,
      ranks: [{ key: "prospect", label: "Prospect", memberCount: 24 }],
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Counts read unavailable", { key: "counts.live" });
    // Recover live and break ranks while both caches are still warm.
    state.liveError = null;
    state.live[0]!.human_member_count = "55";
    state.ranksError = new Error("rank view unavailable");
    vi.setSystemTime(NOW + 59_999);
    expect(await counts.readCounts(env)).toMatchObject({
      memberCount: null,
      ranks: [{ memberCount: 24 }],
    });
    expect(state.liveQueries).toBe(1);
    expect(state.ranksQueries).toBe(1);
    // At expiry each view rereads exactly once and re-settles independently:
    // live recovers, ranks degrades to the empty fallback.
    vi.setSystemTime(NOW + 60_000);
    expect(await counts.readCounts(env)).toMatchObject({ memberCount: 55, ranks: [] });
    expect(state.liveQueries).toBe(2);
    expect(state.ranksQueries).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith("Counts read unavailable", { key: "counts.ranks" });
  });
});
