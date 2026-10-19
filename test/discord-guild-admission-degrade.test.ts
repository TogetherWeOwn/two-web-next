// Guild-id refusal degrades at the request-level source, never a thrown page.
// Blank is the documented local value (wrangler.local.jsonc); a malformed id
// is a typo. Both must give /events 200 with canonical rows and a home teaser
// that still lists canonical events, with zero credentialed fetches.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { discordEventsSource } from "../src/events/discord-transients-source";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";
import { loadHomeUpcomingMerged } from "../src/events/reads";

const NOW = new Date("2030-07-04T18:00:00Z");

function envWithGuild(guildId: unknown): Env {
  return {
    APP_URL: "https://calendar.example.test",
    DISCORD_GUILD_ID: guildId,
    DISCORD_BOT_TOKEN: "fixture-only-bot-token",
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
  } as unknown as Env;
}

function canonicalRow(id: number): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id,
    icsSequence: 1n,
    eventKey: `event-${id}`,
    title: `Game night ${id}`,
    game: null,
    description: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function dbWithRows(rows: (typeof events.$inferSelect)[]): Db {
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql: string, params: unknown[]) => {
    if (typeof sql === "string" && sql.startsWith("select count(*)"))
      return { rows: [[String(rows.length)]] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.includes('from "featured_contents"')) return { rows: [] };
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
    if (sql.includes('"timezone"') && !sql.includes('"title"')) return { rows: [] };
    let selected = [...rows];
    if (sql.includes('"status" =')) selected = selected.filter((r) => r.status === params[0]);
    if (sql.includes('"ends_at" >=')) {
      const cutoff = new Date(String(params[1]));
      selected = selected.filter((r) => r.endsAt >= cutoff);
    }
    if (sql.includes('order by "events"."starts_at" asc')) {
      selected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
    }
    if (sql.includes("limit")) selected = selected.slice(0, Number((params as unknown[]).at(-1)));
    return {
      rows: selected.map((row) =>
        columns.map((key) => {
          const value = row[key];
          if (value instanceof Date) return value.toISOString();
          if (typeof value === "bigint") return value.toString();
          return value;
        }),
      ),
    };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  return db;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("refused guild id degrades at the request-level source", () => {
  it.each([
    ["blank (documented local value)", ""],
    ["malformed", "guild-id"],
  ])(
    "does not throw for a %s guild id and reads empty failed with zero fetches",
    async (_label, guildId) => {
      const fetchSpy = vi.fn(async () => Response.json([]));
      vi.stubGlobal("fetch", fetchSpy);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let source: ReturnType<typeof discordEventsSource>;
      expect(() => {
        source = discordEventsSource(envWithGuild(guildId));
      }).not.toThrow();
      const rows = await source!.upcoming(NOW);
      expect(rows).toEqual([]);
      expect(source!.lastReadFailed()).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith("Discord guild id configuration invalid.");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("guild-id");
    },
  );

  it("home merge still lists canonical events with a blank guild id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = dbWithRows([canonicalRow(1)]);
    const merged = await loadHomeUpcomingMerged(
      async () => db,
      () => discordEventsSource(envWithGuild("")),
      NOW,
    );
    expect(merged.items.map((r) => (r.source === "canonical" ? r.eventKey : null))).toEqual([
      "event-1",
    ]);
    expect(merged.unavailable).toBe(false);
    expect(merged.discordFailed).toBe(true);
  });

  it("calendar model still loads canonical rows with a blank guild id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Same proxy shape as calendar-model-concurrency: count as int8 text,
    // positional upcoming row, empty past drawer and suppression probes.
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
    const row = canonicalRow(1);
    const positional = columns.map((key) => {
      const value = row[key];
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "bigint") return value.toString();
      return value;
    });
    const db = drizzle(async (sql: string) => {
      if (sql.startsWith("select count(*)")) return { rows: [["1"]] };
      if (sql.includes('from "rsvps"')) return { rows: [] };
      if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
      if (sql.includes('"starts_at" asc')) return { rows: [positional] };
      if (sql.includes('"starts_at" desc')) return { rows: [] };
      return { rows: [] };
    }) as unknown as Db;
    const model = await loadCalendarPageModel({
      db,
      input: resolveCalendarInput({}),
      includeDrafts: false,
      discord: discordEventsSource(envWithGuild("")),
      now: NOW,
    });
    expect(model.upcoming.length).toBeGreaterThan(0);
    expect(model.discordFailed).toBe(true);
  });
});
