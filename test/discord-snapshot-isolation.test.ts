import { expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { memoryDiscordBacking, memoryDiscordStore } from "./helpers/discord-snapshot-store";

const env = { APP_URL: "https://calendar.example", DISCORD_GUILD_ID: "123" } as Env;
const good = { upcoming: async () => [], lastReadFailed: () => false };

it("an independent module/store reuses a genuinely successful empty snapshot", async () => {
  const backing = memoryDiscordBacking(() => 1000);
  const first = await import("../src/events/discord-transients");
  await first.cachedDiscordEventsSource(env, good, memoryDiscordStore(backing)).upcoming();
  vi.resetModules();
  const second = await import("../src/events/discord-transients");
  const bad = { upcoming: vi.fn(async () => []), lastReadFailed: () => true };
  const source = second.cachedDiscordEventsSource(env, bad, memoryDiscordStore(backing));
  expect(await source.upcoming()).toEqual([]);
  expect(source.lastReadFailed()).toBe(false);
  expect(bad.upcoming).not.toHaveBeenCalled();
});

it("only one simultaneous cold caller reads Discord; the loser reports honest in-flight cold", async () => {
  const backing = memoryDiscordBacking(() => 2000);
  const module = await import("../src/events/discord-transients");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(async () => {
    await gate;
    return [];
  });
  const inner = { upcoming: read, lastReadFailed: () => false };
  const a = module.cachedDiscordEventsSource(env, inner, memoryDiscordStore(backing));
  const b = module.cachedDiscordEventsSource(env, inner, memoryDiscordStore(backing));
  const pending = a.upcoming();
  expect(await b.upcoming()).toEqual([]);
  expect(b.lastReadFailed()).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
  release();
  expect(await pending).toEqual([]);
  expect(a.lastReadFailed()).toBe(false);
});
