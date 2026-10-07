// Per-isolate cache in front of the Discord scheduled-events read. Discord answers
// bursts of page views with 429 (retry-after 1-10 s); without a cache every second
// view of an otherwise-empty calendar rendered the error state. Hermetic: a fake
// inner source and an injected clock, no Discord, no timers.
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  cachedDiscordEventsSource,
  DISCORD_CACHE_FRESH_MS,
  DISCORD_CACHE_STALE_MS,
  DISCORD_FAILURE_HOLD_MS,
  type DiscordEventsSource,
  resetDiscordEventsCache,
} from "../src/events/discord-transients";
import type { DiscordTransient } from "../src/islands/contracts";

const env = { DISCORD_GUILD_ID: "guild-a" } as Env;
const row = (id: string): DiscordTransient => ({
  discordId: id,
  status: "scheduled",
  title: `Event ${id}`,
  description: null,
  location: null,
  startsAt: new Date("2030-01-02T20:00:00Z"),
  endsAt: null,
});

/** An inner reader that answers from a script and counts how often it was asked. */
function scriptedInner(script: Array<DiscordTransient[] | "fail">) {
  let calls = 0;
  let failed = false;
  const source: DiscordEventsSource = {
    lastReadFailed: () => failed,
    async upcoming() {
      const next = script[Math.min(calls, script.length - 1)] ?? "fail";
      calls += 1;
      failed = next === "fail";
      return next === "fail" ? [] : next;
    },
  };
  return { source, calls: () => calls };
}

function harness(script: Array<DiscordTransient[] | "fail">, guild = env) {
  const inner = scriptedInner(script);
  let now = 1_000_000;
  // One cached source per request, exactly like the route resolves it.
  const request = async () => {
    const source = cachedDiscordEventsSource(guild, inner.source, () => now);
    const rows = await source.upcoming();
    return { rows, failed: source.lastReadFailed() };
  };
  return { inner, request, advance: (ms: number) => (now += ms) };
}

describe("Discord events cache", () => {
  beforeEach(() => resetDiscordEventsCache());

  it("serves a fresh read without calling Discord again", async () => {
    const h = harness([[row("1")]]);
    expect((await h.request()).rows.map((r) => r.discordId)).toEqual(["1"]);
    h.advance(DISCORD_CACHE_FRESH_MS - 1);
    const again = await h.request();
    expect(again).toEqual({ rows: [row("1")], failed: false });
    expect(h.inner.calls()).toBe(1);
  });

  it("reads again once the fresh window has passed", async () => {
    const h = harness([[row("1")], [row("2")]]);
    await h.request();
    h.advance(DISCORD_CACHE_FRESH_MS);
    expect((await h.request()).rows.map((r) => r.discordId)).toEqual(["2"]);
    expect(h.inner.calls()).toBe(2);
  });

  it("caches a clean empty read: an empty guild is not an outage", async () => {
    const h = harness([[], "fail"]);
    expect(await h.request()).toEqual({ rows: [], failed: false });
    h.advance(DISCORD_CACHE_FRESH_MS - 1);
    expect(await h.request()).toEqual({ rows: [], failed: false });
    expect(h.inner.calls()).toBe(1);
  });

  it("serves the last good rows, not the error state, when a later read fails", async () => {
    const h = harness([[row("1")], "fail"]);
    await h.request();
    h.advance(DISCORD_CACHE_FRESH_MS);
    expect(await h.request()).toEqual({ rows: [row("1")], failed: false });
    expect(h.inner.calls()).toBe(2);
  });

  it("stops serving stale rows once they are older than the stale window", async () => {
    const h = harness([[row("1")], "fail"]);
    await h.request();
    h.advance(DISCORD_CACHE_STALE_MS);
    expect(await h.request()).toEqual({ rows: [], failed: true });
  });

  it("holds Discord off after a failure, then retries", async () => {
    const h = harness([[row("1")], "fail", [row("2")]]);
    await h.request();
    h.advance(DISCORD_CACHE_FRESH_MS);
    await h.request(); // fails, serves stale, starts the hold
    h.advance(DISCORD_FAILURE_HOLD_MS - 1);
    expect(await h.request()).toEqual({ rows: [row("1")], failed: false });
    expect(h.inner.calls()).toBe(2);
    h.advance(1);
    expect((await h.request()).rows.map((r) => r.discordId)).toEqual(["2"]);
    expect(h.inner.calls()).toBe(3);
  });

  it("is the error state, and still held, when a cold isolate fails with nothing to serve", async () => {
    const h = harness(["fail", [row("1")]]);
    expect(await h.request()).toEqual({ rows: [], failed: true });
    h.advance(DISCORD_FAILURE_HOLD_MS - 1);
    expect(await h.request()).toEqual({ rows: [], failed: true });
    expect(h.inner.calls()).toBe(1);
    h.advance(1);
    expect(await h.request()).toEqual({ rows: [row("1")], failed: false });
  });

  it("keeps guilds apart", async () => {
    const a = harness([[row("a")]]);
    const b = harness([[row("b")]], { DISCORD_GUILD_ID: "guild-b" } as Env);
    expect((await a.request()).rows.map((r) => r.discordId)).toEqual(["a"]);
    expect((await b.request()).rows.map((r) => r.discordId)).toEqual(["b"]);
  });

  it("hands each request its own array, so a caller cannot corrupt the cache", async () => {
    const h = harness([[row("1")]]);
    const first = await h.request();
    first.rows.length = 0;
    expect((await h.request()).rows.map((r) => r.discordId)).toEqual(["1"]);
  });
});
