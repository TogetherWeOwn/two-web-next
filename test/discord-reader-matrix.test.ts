// Discord transient reader behavior matrix (TOG-12271): ports the legacy
// Unit/Events/DiscordEventsReaderTest behavior rows beyond field-type
// admission (TOG-11395, test/discord-transient-shape.test.ts) and the deadline
// suite — invalid id/time/name filtering, sanitized outage fail-open, invalid
// payload failure, and failure reset after a clean empty read. Hermetic:
// mocked fetch / Response JSON plus a pg-proxy mount; no Discord, no database.
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { liveDiscordEventsSource } from "../src/events/discord-transients";
import { registerEventRoutes } from "../src/events/routes";
import { EVENTS_EMPTY_ERROR_TESTID, EVENTS_EMPTY_SEARCH_TESTID } from "../src/islands/contracts";

const NOW = new Date("2030-01-01T00:00:00Z");
const TOKEN = "fixture-bot-token-must-never-echo";
const env = {
  APP_URL: "https://calendar.example.test",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: TOKEN,
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
} as unknown as Env;

function event(over: Record<string, unknown> = {}) {
  return {
    id: "1545955994972987422",
    name: "Sunday Squad",
    description: "Fall Guys for about an hour.",
    scheduled_start_time: "2030-01-02T20:00:00Z",
    scheduled_end_time: "2030-01-02T21:00:00Z",
    status: 1,
    entity_metadata: { location: "Lobby" },
    ...over,
  };
}

function mountedCalendar() {
  const db = drizzle(async () => ({ rows: [] }));
  // Search analytics uses a transaction; the pg-proxy fixture has no real SQL.
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) =>
      fn({
        execute: async () => {},
        insert: () => ({ values: async () => {} }),
      } as unknown as Db),
  });
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(
    app,
    async () => null,
    async () => null,
  );
  return { app, bindings: { ...env, ADMIN_DB: db as unknown as Db } as Env };
}

describe("Discord transient reader matrix", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("filters rows with invalid id, time or name and keeps healthy siblings", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json([
          event(),
          event({ id: "", name: "Nameless id" }),
          event({ id: 42, name: "Numeric id" }),
          event({ id: "bad-start", scheduled_start_time: "not-a-time" }),
          event({ id: "bad-end", scheduled_end_time: "invalid" }),
          event({ id: "blank-name", name: "   " }),
          event({ id: "empty-name", name: "" }),
          event({ id: "null-name", name: null }),
        ]),
      );
    const source = liveDiscordEventsSource(env);
    const rows = await source.upcoming(NOW);
    expect(rows.map((row) => row.discordId)).toEqual(["1545955994972987422"]);
    expect(source.lastReadFailed()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails open on outage without echoing secrets and keeps the calendar a 200", async () => {
    const spies = ["error", "warn", "info", "debug"].map((level) =>
      vi.spyOn(console, level as "error").mockImplementation(() => {}),
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(`connect Bot ${TOKEN} secret`));
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(NOW)).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    for (const spy of spies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
    const { app, bindings } = mountedCalendar();
    const response = await app.request("/events", undefined, bindings);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(EVENTS_EMPTY_ERROR_TESTID);
  });

  it.each([
    ["JSON string", '"invalid-event-result"'],
    ["number", "42"],
    ["null", "null"],
    ["object", '{"message":"nope"}'],
  ])("reports an invalid %s payload as a failed read", async (_label, body) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(body, { headers: { "content-type": "application/json" } }),
      );
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(NOW)).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("clears a previous failure after a clean empty read", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("unavailable"));
    fetch.mockResolvedValueOnce(Response.json([]));
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(NOW)).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
    expect(await source.upcoming(NOW)).toEqual([]);
    expect(source.lastReadFailed()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("keeps the search-miss block when Discord rate-limits the next page view", async () => {
    // Staging: every second view of a burst got a 429. The first clean read is cached,
    // so the second view never calls Discord and cannot turn the miss into the error state.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValue(
        new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }),
      );
    const { app, bindings } = mountedCalendar();
    for (const q of ["zzqxj-nomatch-1", "zzqxj-nomatch-2"]) {
      const html = await (await app.request(`/events?q=${q}`, undefined, bindings)).text();
      expect(html).toContain(EVENTS_EMPTY_SEARCH_TESTID);
      expect(html).not.toContain(EVENTS_EMPTY_ERROR_TESTID);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
