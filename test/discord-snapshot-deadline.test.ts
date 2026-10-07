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
  it("bounds streamed HTTP bytes and cancels oversized bodies before parsing or storage", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(DISCORD_SNAPSHOT_MAX_BYTES + 1));
      },
      cancel,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming()).toEqual([]);
    expect(source.lastReadFailure?.()?.reason).toBe("invalid_payload");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    [429, "35.25", 35_250],
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
      expect(reader.lastReadFailure?.()?.retryAfter).toBe(35.25);
  });
});
