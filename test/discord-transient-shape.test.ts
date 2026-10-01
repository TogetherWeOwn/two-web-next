// Hermetic live-reader regressions: real Response JSON, no Discord or database.
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { liveDiscordEventsSource } from "../src/events/discord-transients";
import { registerEventRoutes } from "../src/events/routes";

const NOW = new Date("2030-01-01T00:00:00Z");
const env = {
  APP_URL: "https://calendar.example.test",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_BOT_TOKEN: "fixture-only-token",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
} as unknown as Env;

function event(over: Record<string, unknown> = {}) {
  return {
    id: "1545955994972987422",
    name: "Healthy raid",
    description: "Bring a squad",
    scheduled_start_time: "2030-01-02T20:00:00Z",
    scheduled_end_time: "2030-01-02T21:00:00Z",
    status: 1,
    entity_metadata: { location: "Lobby" },
    ...over,
  };
}

function mockPayload(payload: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(payload));
}

function mountedCalendar() {
  const db = drizzle(async () => ({ rows: [] }));
  // Search analytics uses a transaction; the pg-proxy fixture has no real SQL.
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) => fn({
      execute: async () => {},
      insert: () => ({ values: async () => {} }),
    } as unknown as Db),
  });
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(app, async () => null, async () => null);
  return { app, bindings: { ...env, ADMIN_DB: db as unknown as Db } as Env };
}

describe("Discord transient payload admission", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("drops wrong required and optional string types before exposing transients", async () => {
    mockPayload([
      event({ id: 42 }),
      event({ name: 42 }),
      event({ description: {} }),
      event({ entity_metadata: { location: 42 } }),
      event(),
    ]);
    const source = liveDiscordEventsSource(env);
    const rows = await source.upcoming(NOW);
    expect(rows.map((row) => row.title)).toEqual(["Healthy raid"]);
    expect(source.lastReadFailed()).toBe(false);
  });

  it("treats a non-array payload as a failed read (whole-payload), not a throw", async () => {
    mockPayload({ message: "nope" });
    const source = liveDiscordEventsSource(env);
    expect(await source.upcoming(NOW)).toEqual([]);
    expect(source.lastReadFailed()).toBe(true);
  });

  it("keeps a healthy sibling when a mixed array contains null and primitives", async () => {
    mockPayload([null, false, "bad row", 42, [], event()]);
    const source = liveDiscordEventsSource(env);
    expect((await source.upcoming(NOW)).map((row) => row.title)).toEqual(["Healthy raid"]);
    expect(source.lastReadFailed()).toBe(false);
  });

  it.each([
    ["healthy control", {}],
    ["numeric title", { name: 42 }],
    ["object description", { name: "Other event", description: {} }],
  ])("renders safe 200 search responses (%s)", async (_label, malformed) => {
    vi.setSystemTime(NOW);
    const fetch = mockPayload([event(malformed), event()]);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, bindings } = mountedCalendar();
    const response = await app.request("/events?q=raid", undefined, bindings);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Healthy raid");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
