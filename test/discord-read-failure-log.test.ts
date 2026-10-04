// Why the calendar's Discord read failed must be visible in the Worker logs:
// the error empty state alone cannot tell a revoked token (401/403), a rate
// limit (429), a deadline miss or a network fault apart. Logs carry the failure
// class only: never a message, header, URL or body, because a driver message can
// echo the bot token. Hermetic: mocked fetch, no Discord.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  DISCORD_READ_DEADLINE_MS,
  liveDiscordEventsSource,
} from "../src/events/discord-transients";

const NOW = new Date("2030-01-01T00:00:00Z");
const TOKEN = "fixture-bot-token-must-never-echo";
const env = { DISCORD_GUILD_ID: "326474832151838730", DISCORD_BOT_TOKEN: TOKEN } as Env;
const MESSAGE = "Discord scheduled-events read failed; rendering the error state.";

function warnings() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("Discord scheduled-events read failure logging", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("logs the status of a rejected read without reading its body", async () => {
    const warn = warnings();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "Missing Access", code: 50001 }, { status: 403 }),
    );
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(NOW)).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      MESSAGE,
      expect.objectContaining({ reason: "status", status: 403 }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Missing Access");
  });

  it("logs retry-after for a rate limit and ignores a non-numeric one", async () => {
    const warn = warnings();
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "retry-after": "2.5" } }),
    );
    fetch.mockResolvedValueOnce(
      new Response("not json", { status: 429, headers: { "retry-after": "soon" } }),
    );
    const source = liveDiscordEventsSource(env);
    await source.upcoming(NOW);
    await source.upcoming(NOW);
    const [first, second] = warn.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(first).toMatchObject({ reason: "status", status: 429, retryAfter: 2.5 });
    expect(second).toMatchObject({ reason: "status", status: 429 });
    expect(second!.retryAfter).toBeUndefined();
  });

  it("omits retry-after when the header is absent or empty", async () => {
    const warn = warnings();
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    fetch.mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "retry-after": "" } }),
    );
    const source = liveDiscordEventsSource(env);
    await source.upcoming(NOW);
    await source.upcoming(NOW);
    const [absent, empty] = warn.mock.calls.map((call) => call[1] as Record<string, unknown>);
    expect(absent).toMatchObject({ reason: "status", status: 403 });
    expect(absent!.retryAfter).toBeUndefined();
    expect(empty).toMatchObject({ reason: "status", status: 429 });
    expect(empty!.retryAfter).toBeUndefined();
  });

  it("logs a deadline miss with the elapsed time", async () => {
    const warn = warnings();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
    const read = liveDiscordEventsSource(env).upcoming(NOW);
    await vi.advanceTimersByTimeAsync(DISCORD_READ_DEADLINE_MS);
    expect(await read).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      MESSAGE,
      expect.objectContaining({ reason: "deadline", elapsedMs: DISCORD_READ_DEADLINE_MS }),
    );
  });

  it("logs a 2xx that is not a list as an invalid payload", async () => {
    const warn = warnings();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ message: "nope" }));
    await liveDiscordEventsSource(env).upcoming(NOW);
    expect(warn).toHaveBeenCalledWith(
      MESSAGE,
      expect.objectContaining({ reason: "invalid_payload" }),
    );
  });

  it("logs a network fault by class name only, never its message", async () => {
    const warn = warnings();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError(`connect Bot ${TOKEN} refused`));
    await liveDiscordEventsSource(env).upcoming(NOW);
    expect(warn).toHaveBeenCalledWith(
      MESSAGE,
      expect.objectContaining({ reason: "exception", exception: "TypeError" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it("stays quiet when the read succeeds", async () => {
    const warn = warnings();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(NOW)).toEqual([]);
    expect(source.lastReadFailed()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
