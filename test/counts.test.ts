import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

const state = vi.hoisted(() => ({
  live: [] as Record<string, unknown>[],
  ranks: [] as Record<string, unknown>[],
  liveError: null as Error | null,
  ranksError: null as Error | null,
  constructorError: null as Error | null,
  endError: null as Error | null,
  hung: false,
  delayMs: 0,
  queries: [] as string[],
  urls: [] as string[],
  options: [] as Record<string, unknown>[],
  ends: 0,
}));
vi.mock("postgres", () => ({
  default: (url: string, options: Record<string, unknown>) => {
    state.urls.push(url);
    state.options.push(options);
    if (state.constructorError) throw state.constructorError;
    const sql = async (parts: TemplateStringsArray) => {
      const query = parts.join("");
      state.queries.push(query);
      if (state.hung) return new Promise(() => {});
      const live = query.includes("web_v1.live_counts");
      const error = live ? state.liveError : state.ranksError;
      const rows = (live ? state.live : state.ranks).map((row) => ({ ...row }));
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (error) throw error;
      return rows;
    };
    sql.end = async () => {
      state.ends++;
      if (state.endError) throw state.endError;
    };
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
    constructorError: null,
    endError: null,
    hung: false,
    delayMs: 0,
    queries: [],
    urls: [],
    options: [],
    ends: 0,
  });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  counts = await import("../src/counts");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readCounts contract", () => {
  it("does not connect when no database is configured", async () => {
    expect(await counts.readCounts({} as Env)).toEqual(counts.UNAVAILABLE);
    expect(state.urls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads both bot views through BOT_DB, converts bigint strings, and closes clients", async () => {
    expect(await counts.readCounts(env)).toEqual({
      memberCount: 84,
      onlineCount: 12,
      ranks: [{ key: "prospect", label: "Prospect", memberCount: 24 }],
    });
    expect(state.urls).toEqual([env.BOT_DB!.connectionString, env.BOT_DB!.connectionString]);
    expect(state.queries[0]).toContain("human_member_count, online_count, counts_updated_at");
    expect(state.queries[1]).toContain("ORDER BY rank_order");
    expect(state.options[0]).toMatchObject({
      prepare: false,
      fetch_types: false,
      max: 1,
      connect_timeout: 2,
    });
    expect(state.ends).toBe(2);
  });

  it("uses the explicit local/dev URL without trying a second credential", async () => {
    await counts.readCounts({ ...env, BOT_DATABASE_URL: "postgres://fixture.test/explicit" });
    expect(state.urls).toEqual([
      "postgres://fixture.test/explicit",
      "postgres://fixture.test/explicit",
    ]);
  });

  it("never reads the web database: web-only sources stay hidden without connecting", async () => {
    const webOnly = {
      DATABASE_URL: "postgres://fixture.test/web",
      DB: { connectionString: "postgres://fixture.test/web" },
    } as Env;
    expect(await counts.readCounts(webOnly)).toEqual(counts.UNAVAILABLE);
    expect(state.urls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [0, true],
    [599_999, true],
    [600_000, false],
    [600_001, false],
    [-599_999, true],
    [-600_000, false],
    [86_400_000, false],
  ])("absolute snapshot age %i ms has visible numerals = %s", async (age, fresh) => {
    state.live[0]!.counts_updated_at = new Date(NOW - age).toISOString();
    expect((await counts.readCounts(env)).memberCount).toBe(fresh ? 84 : null);
  });

  it.each([null, "", "not a date", new Date(NaN), 123])(
    "hides counts for an unusable timestamp %s",
    async (stamp) => {
      state.live[0]!.counts_updated_at = stamp;
      expect(await counts.readCounts(env)).toMatchObject({ memberCount: null, onlineCount: null });
    },
  );

  it("keeps unavailable distinct from zero and never exposes online without a member count", async () => {
    state.live[0]!.human_member_count = null;
    expect(await counts.readCounts(env)).toMatchObject({ memberCount: null, onlineCount: null });
    state.live[0]!.human_member_count = "0";
    state.live[0]!.online_count = null;
    vi.setSystemTime(NOW + counts.COUNTS_CACHE_TTL_MS);
    expect(await counts.readCounts(env)).toMatchObject({ memberCount: 0, onlineCount: null });
  });

  it.each([-1, "-1", "", "oops", 1.5, Number.NaN, "9007199254740992"])(
    "refuses malformed count %s",
    async (value) => {
      state.live[0]!.human_member_count = value;
      expect((await counts.readCounts(env)).memberCount).toBeNull();
    },
  );

  it("degrades an empty live view without hiding readable ranks", async () => {
    state.live = [];
    expect(await counts.readCounts(env)).toMatchObject({
      memberCount: null,
      ranks: [{ memberCount: 24 }],
    });
  });

  it("a rank failure does not hide fresh live counts", async () => {
    state.ranksError = new Error("missing rank view");
    expect(await counts.readCounts(env)).toEqual({ memberCount: 84, onlineCount: 12, ranks: [] });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Counts read unavailable", {
      key: "counts.ranks",
    });
  });
});

describe("60-second isolate cache", () => {
  it("caches only settled reads across env objects and refreshes at expiry", async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => counts.readCounts({ ...env })),
    );
    expect(replies.every((reply) => reply.memberCount === 84)).toBe(true);
    expect(state.queries).toHaveLength(16); // Cold callers own their I/O and deadlines.
    state.live[0]!.human_member_count = "99";
    vi.setSystemTime(NOW + 59_999);
    expect((await counts.readCounts({ ...env })).memberCount).toBe(84);
    expect(state.queries).toHaveLength(16);
    vi.setSystemTime(NOW + 60_000);
    expect((await counts.readCounts(env)).memberCount).toBe(99);
    expect(state.queries).toHaveLength(18);
  });

  it("does not let an unresolved fill own a later caller's deadline", async () => {
    state.hung = true;
    const first = counts.readCounts(env);
    await vi.advanceTimersByTimeAsync(300);
    state.hung = false;
    await expect(counts.readCounts(env)).resolves.toMatchObject({ memberCount: 84 });
    expect(state.queries).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(counts.COUNTS_READ_TIMEOUT_MS - 300);
    await expect(first).resolves.toEqual(counts.UNAVAILABLE);
    expect((await counts.readCounts(env)).memberCount).toBe(84);
    expect(state.queries).toHaveLength(4);
  });

  it.each([false, true])(
    "warms the cache during overlapping arrivals (failed reads: %s)",
    async (failed) => {
      state.delayMs = 1000;
      if (failed) state.liveError = state.ranksError = new Error("fixture unavailable");
      const replies: Promise<import("../src/counts").Counts>[] = [];
      for (let i = 0; i < 12; i++) {
        replies.push(counts.readCounts(env));
        await vi.advanceTimersByTimeAsync(150);
      }
      // Seven cold arrivals precede the first completion; the next five reuse
      // settled values even while later fills are still pending.
      expect(state.queries).toHaveLength(14);
      await vi.advanceTimersByTimeAsync(1000);
      const results = await Promise.all(replies);
      expect(results.every((reply) => reply.memberCount === (failed ? null : 84))).toBe(true);
      expect(state.ends).toBe(14);
      expect(warn).toHaveBeenCalledTimes(failed ? 14 : 0);
      await counts.readCounts(env);
      expect(state.queries).toHaveLength(14);
    },
  );

  it("publishes an older completion while a newer fill is still pending", async () => {
    state.delayMs = 1000;
    const first = counts.readCounts(env);
    await vi.advanceTimersByTimeAsync(150);
    state.hung = true;
    const newer = counts.readCounts(env);
    await vi.advanceTimersByTimeAsync(850);
    await expect(first).resolves.toMatchObject({ memberCount: 84 });
    await expect(counts.readCounts(env)).resolves.toMatchObject({ memberCount: 84 });
    expect(state.queries).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1150);
    await expect(newer).resolves.toEqual(counts.UNAVAILABLE);
  });

  it("does not carry a snapshot between different database URLs", async () => {
    await counts.readCounts(env);
    state.live[0]!.human_member_count = "7";
    expect(
      (
        await counts.readCounts({
          BOT_DB: { connectionString: "postgres://fixture.test/other" },
        } as Env)
      ).memberCount,
    ).toBe(7);
    expect(state.queries).toHaveLength(4);
  });

  it("does not let an older URL's completion evict a newer published connection", async () => {
    state.delayMs = 1000;
    const older = counts.readCounts(env);
    await vi.advanceTimersByTimeAsync(150);
    state.delayMs = 0;
    state.live[0]!.human_member_count = "99";
    const other = { BOT_DB: { connectionString: "postgres://fixture.test/other" } } as Env;
    await expect(counts.readCounts(other)).resolves.toMatchObject({ memberCount: 99 });
    await vi.advanceTimersByTimeAsync(850);
    await expect(older).resolves.toMatchObject({ memberCount: 84 });
    state.hung = true;
    await expect(counts.readCounts(other)).resolves.toMatchObject({ memberCount: 99 });
    expect(state.queries).toHaveLength(4);
  });

  it("serves a warm snapshot through outage, then degrades and logs once per failed fill", async () => {
    await counts.readCounts(env);
    state.liveError = new Error("secret-bearing database error must never be logged");
    vi.setSystemTime(NOW + 59_999);
    expect((await counts.readCounts(env)).memberCount).toBe(84);
    expect(warn).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 60_000);
    expect((await counts.readCounts(env)).memberCount).toBeNull();
    await counts.readCounts(env);
    expect(warn).toHaveBeenCalledExactlyOnceWith("Counts read unavailable", { key: "counts.live" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-bearing");
    vi.setSystemTime(NOW + 120_000);
    state.liveError = null;
    expect((await counts.readCounts(env)).memberCount).toBe(84);
  });

  it.each(["constructorError", "endError"] as const)("never throws on %s", async (key) => {
    state[key] = new Error("driver failed");
    await expect(counts.readCounts(env)).resolves.toEqual(counts.UNAVAILABLE);
    expect(warn).toHaveBeenCalledTimes(2); // Each independent view fails once.
    await counts.readCounts(env);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung read and closes both clients", async () => {
    state.hung = true;
    const pending = counts.readCounts(env);
    await vi.advanceTimersByTimeAsync(counts.COUNTS_READ_TIMEOUT_MS);
    await expect(pending).resolves.toEqual(counts.UNAVAILABLE);
    expect(state.ends).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
