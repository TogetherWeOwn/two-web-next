import type postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  pgDiscordSnapshotStore,
  DISCORD_STORE_DEADLINE_MS,
} from "../src/events/discord-snapshot-postgres";
import {
  cachedDiscordEventsSource,
  liveDiscordEventsSource,
  DISCORD_READ_DEADLINE_MS,
} from "../src/events/discord-transients";
import { DISCORD_SNAPSHOT_MAX_BYTES, discordSnapshotKey } from "../src/events/discord-snapshot";
import { memoryDiscordBacking, memoryDiscordStore } from "./helpers/discord-snapshot-store";

const env = {
  APP_URL: "https://calendar.example",
  DISCORD_GUILD_ID: "123",
  DISCORD_BOT_TOKEN: "fixture",
} as Env;

function liveBodyAtByteLimit(over: number) {
  const event = {
    id: "1",
    name: "Launch 🚀",
    scheduled_start_time: "2030-01-02T20:00:00Z",
    fixture_padding: "",
  };
  const limit = DISCORD_SNAPSHOT_MAX_BYTES + over;
  event.fixture_padding = "x".repeat(limit - Buffer.byteLength(JSON.stringify([event])));
  const json = JSON.stringify([event]);
  const bytes = new TextEncoder().encode(json);
  expect(bytes.byteLength).toBe(limit);
  // The prefix is ASCII. Split after the first byte of the four-byte emoji.
  const split = json.indexOf("🚀") + 1;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.subarray(0, split));
      c.enqueue(bytes.subarray(split));
      // Oversize must reject without waiting for EOF.
      if (over === 0) c.close();
    },
    cancel,
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
  return { body, cancel };
}

describe("request-owned snapshot I/O deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("terminates a hung storage operation and forbids continuation writes after timeout", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const query = vi.fn(async () => {
      await gate;
      return [];
    });
    const end = vi.fn(async () => {});
    const client = {
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(query),
      end,
    } as unknown as ReturnType<typeof postgres>;
    const http = vi.fn(async () => []);
    const source = cachedDiscordEventsSource(
      env,
      { upcoming: http, lastReadFailed: () => false },
      pgDiscordSnapshotStore(() => client),
    );
    const pending = source.upcoming();
    await vi.advanceTimersByTimeAsync(DISCORD_STORE_DEADLINE_MS - 1);
    expect(end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(end).toHaveBeenCalledWith({ timeout: 0 });
    expect(http).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("set_config('transaction_timeout', ")]),
      "350ms",
      "400ms",
      `${DISCORD_STORE_DEADLINE_MS}ms`,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a stalled HTTP body, installs a hold, and never publishes its buffered success", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("[]"));
      },
      cancel,
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const backing = memoryDiscordBacking();
    const source = cachedDiscordEventsSource(
      env,
      liveDiscordEventsSource(env),
      memoryDiscordStore(backing),
    );
    const pending = source.upcoming();
    await vi.advanceTimersByTimeAsync(DISCORD_READ_DEADLINE_MS);
    expect(await pending).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    const entry = backing.entries.get(discordSnapshotKey(env))!;
    expect(entry.payload).toBeNull();
    expect(entry.retryAt).toBe(Date.now() + 10_000);
  });
  it.each([true, false])(
    "request cannot publish a late %s completed result through an expired owner",
    async (successful) => {
      const backing = memoryDiscordBacking();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const source = cachedDiscordEventsSource(
        env,
        {
          upcoming: async () => {
            await gate;
            return [];
          },
          lastReadFailed: () => !successful,
        },
        memoryDiscordStore(backing),
      );
      const pending = source.upcoming();
      await vi.advanceTimersByTimeAsync(5_000);
      const replacement = await memoryDiscordStore(backing).claim(discordSnapshotKey(env));
      release();
      expect(await pending).toEqual([]);
      expect(source.lastReadFailed()).toBe(true);
      const entry = backing.entries.get(discordSnapshotKey(env))!;
      expect(entry.token).toBe(replacement.token);
      expect(entry.payload).toBeNull();
      expect(entry.retryAt).toBe(0);
    },
  );
  it("accepts exactly the streamed HTTP byte cap and decodes a split UTF-8 character", async () => {
    const { body, cancel } = liveBodyAtByteLimit(0);
    const source = liveDiscordEventsSource(env);
    const rows = await source.upcoming(new Date("2030-01-01T00:00:00Z"));
    expect(rows.map((row) => row.title)).toEqual(["Launch 🚀"]);
    expect(source.lastReadFailed()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a streamed HTTP body one byte over the cap before parsing or storage", async () => {
    const { body, cancel } = liveBodyAtByteLimit(1);
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming()).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(source.lastReadFailure?.()?.reason).toBe("invalid_payload");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    // Fractions ceil under the shared Retry-After parser: a 35.25s header
    // holds the cache 36s and reports retryAfter 36, never sooner.
    [429, "35.25", 36_000],
    [429, "soon", 10_000],
    [429, "0x20", 10_000],
    [429, "-1", 10_000],
    [429, "Infinity", 10_000],
    [500, "35.25", 10_000],
  ])("propagates sanitized HTTP %s retry %s without log parsing", async (status, retry, hold) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status, headers: { "retry-after": retry } }),
    );
    const backing = memoryDiscordBacking();
    const reader = liveDiscordEventsSource(env);
    const source = cachedDiscordEventsSource(env, reader, memoryDiscordStore(backing));
    expect(await source.upcoming()).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(backing.entries.get(discordSnapshotKey(env))!.retryAt).toBe(Date.now() + hold);
    const metadata = reader.lastReadFailure?.();
    if (metadata) metadata.retryAfter = 0;
    if (status === 429 && retry === "35.25")
      expect(reader.lastReadFailure?.()?.retryAfter).toBe(36);
  });
});
