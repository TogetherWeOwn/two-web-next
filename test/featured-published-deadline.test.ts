// Builder-owned: the published featured read's deadline rejects to
// cachedFeatured, which logs the one home-pattern warn and serves [].
//
// The legacy visible path keeps its swallowing deadline (never throws); only
// the published base (homepage guest cache) propagates, so a transport stall
// warns exactly like a read throw: bounded `ReadFailure`, validated request
// id, never driver text. Mutation check: flipping the deadline back to
// `resolve([])` re-silences the stall and this test fails on the missing warn.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { FEATURED_READ_DEADLINE_MS } from "../src/featured";
import { __resetHomeGuestCacheForTests, cachedFeatured } from "../src/home-cache";

const NOW = new Date("2030-07-04T18:00:00Z");
// Allowlisted synthetic ULID (see .gitleaks.toml).
const RID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

afterEach(() => {
  __resetHomeGuestCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("published featured deadline warns once and serves []", () => {
  it("a stalled read warns with the request id at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stalled = { transaction: () => new Promise<never>(() => {}) } as unknown as Db;
    const pending = cachedFeatured(baseEnv, async () => stalled, NOW, undefined, RID);
    await vi.advanceTimersByTimeAsync(FEATURED_READ_DEADLINE_MS + 100);
    await expect(pending).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Home featured unavailable; serving the fallback.", {
      request_id: RID,
      exception: "ReadFailure",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
