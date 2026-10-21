// Homepage source-aware teaser: canonical plus display-only Discord rows.
// Local fixtures only, generic titles (no deleted test-event names).
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  HOME_DISCORD_TIMEOUT_MS,
  HOME_EVENTS_DB_TIMEOUT_MS,
  mergeHomeUpcoming,
  loadHomeUpcomingMerged,
  type HomeEvent,
} from "../src/events/reads";
import type { DiscordTransient } from "../src/islands/contracts";

const NOW = new Date("2030-07-04T18:00:00Z");
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

function canonical(
  id: number,
  overrides: Partial<typeof events.$inferSelect> = {},
): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id,
    icsSequence: 1n,
    eventKey: `event-${id}`,
    title: `Game night ${id}`,
    game: null,
    description: "Private host notes",
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
    createdBy: "private-creator-id",
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function transient(
  id: string,
  startOffsetHours: number,
  title = `Discord game night ${id}`,
  endOffsetHours: number | null = 2,
): DiscordTransient {
  const startsAt = new Date(NOW.getTime() + startOffsetHours * 3600_000);
  return {
    discordId: id,
    status: "scheduled",
    title,
    description: "Discord public description",
    location: "Lobby voice room",
    startsAt,
    endsAt:
      endOffsetHours === null ? null : new Date(startsAt.getTime() + endOffsetHours * 3600_000),
  };
}

function homeRow(row: typeof events.$inferSelect): HomeEvent {
  return {
    eventKey: row.eventKey,
    title: row.title,
    startsAt: row.startsAt,
    timezone: row.timezone,
    location: row.location,
    goingCount: 0,
    goingOccupancy: 0,
    capacity: row.capacity,
  };
}

function fixture(
  rows: (typeof events.$inferSelect)[] = [],
  discord: { rows?: DiscordTransient[]; failed?: boolean } = {},
) {
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "featured_contents"')) return { rows: [] };
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) {
      return {
        rows: rows
          .filter(
            (r) => r.discordEventId !== null && (params as unknown[]).includes(r.discordEventId),
          )
          .map((r) => [r.discordEventId]),
      };
    }
    // Past-zones probe for the /events-parity display zone: the homepage
    // derives the Discord-row zone from canonical upcoming zones plus a
    // capped set of recent past zones, like loadCalendarPageModel. The probe
    // selects only the timezone column (no title), so it is distinguished
    // here from the canonical teaser and the suppression probe.
    if (sql.includes('"timezone"') && !sql.includes('"title"')) {
      const cutoff = new Date(
        String((params as unknown[]).find((p) => !Number.isNaN(Date.parse(String(p)))) ?? NOW),
      );
      const past = rows
        .filter((r) => r.status !== "draft" && r.endsAt < cutoff)
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || b.id - a.id)
        .slice(0, Number((params as unknown[]).at(-1) ?? 20));
      return { rows: past.map((r) => [r.timezone]) };
    }
    let selected = [...rows];
    if (sql.includes('"status" =')) selected = selected.filter((r) => r.status === params[0]);
    if (sql.includes('"ends_at" >='))
      selected = selected.filter((r) => r.endsAt >= new Date(String(params[1])));
    if (sql.includes('order by "events"."starts_at" asc')) {
      selected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
    }
    if (sql.includes("limit")) selected = selected.slice(0, Number((params as unknown[]).at(-1)));
    return {
      rows: selected.map((row) =>
        columns.map((key) => {
          const value = row[key];
          return value instanceof Date ? value.toISOString() : value;
        }),
      ),
    };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const discordRows = discord.rows ?? [];
  const discordFailed = discord.failed ?? false;
  const env = {
    ...baseEnv,
    ADMIN_DB: db,
    DISCORD_EVENTS: {
      upcoming: async () => discordRows,
      lastReadFailed: () => discordFailed,
    },
  } as Env;
  return { db, env, request: () => app.request("/", {}, env) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mergeHomeUpcoming (shared with the SvelteKit card)", () => {
  it("keeps canonical-only order and labels each row canonical", () => {
    const rows = [canonical(2), canonical(1)].map(homeRow);
    const merged = mergeHomeUpcoming(rows, [], new Set(), NOW);
    expect(merged.map((r) => (r.source === "canonical" ? r.eventKey : null))).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(merged.every((r) => r.source === "canonical")).toBe(true);
  });

  it("shows a Discord-only row with the canonical zone fallback and no RSVP aggregate", () => {
    const merged = mergeHomeUpcoming([], [transient("d1", 5)], new Set(), NOW);
    expect(merged).toHaveLength(1);
    const [row] = merged;
    expect(row!.source).toBe("discord");
    if (row!.source !== "discord") throw new Error("narrowing");
    expect(row!.discordId).toBe("d1");
    expect(row!.timezone).toBe("UTC");
    expect("goingCount" in row!).toBe(false);
    expect("eventKey" in row!).toBe(false);
  });

  it("merges both sources in start order and caps at three", () => {
    const canonicalRows = [canonical(10), canonical(30), canonical(20), canonical(40)].map(homeRow);
    const discordRows = [transient("d-early", 5), transient("d-late", 50)];
    const merged = mergeHomeUpcoming(canonicalRows, discordRows, new Set(), NOW);
    expect(merged).toHaveLength(3);
    // d-early (5h) first, then the two soonest canonical rows.
    expect(merged[0]!.source).toBe("discord");
    expect(merged[1]!.source).toBe("canonical");
    expect(merged[2]!.source).toBe("canonical");
  });

  it("suppresses a Discord copy when the same id is persisted (hidden-event suppression)", () => {
    const persisted = canonical(1, { discordEventId: "d1" });
    const merged = mergeHomeUpcoming(
      [homeRow(persisted)],
      [transient("d1", 1), transient("d2", 2)],
      new Set(["d1"]),
      NOW,
    );
    expect(merged.map((r) => (r.source === "discord" ? r.discordId : "canonical"))).toEqual([
      "canonical",
      "d2",
    ]);
  });

  it("drops ended Discord rows but keeps no-end voice events", () => {
    const ended = transient("ended", -5, "Ended game night", -1);
    const noEnd = transient("live-voice", -1, "Live voice hangout", null);
    const merged = mergeHomeUpcoming([], [ended, noEnd], new Set(), NOW);
    expect(merged.map((r) => (r.source === "discord" ? r.discordId : null))).toEqual([
      "live-voice",
    ]);
  });
});

describe("homepage Discord rendering", () => {
  it("renders a Discord-only teaser with the Discord link and no going count or detail link", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const html = await (
      await fixture([], { rows: [transient("d1", 5, "Friday community games")] }).request()
    ).text();
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain('data-source="discord"');
    expect(html).toContain("Friday community games");
    expect(html).toContain('data-testid="home-event-discord"');
    expect(html).toContain('href="https://discord.gg/invite"');
    expect(html).toContain("RSVP in Discord");
    expect(html).not.toContain("going");
    expect(html).not.toContain("/e/discord-");
    expect(html).not.toContain("d1");
    expect(html).not.toContain("Discord public description");
  });

  it("renders canonical and Discord rows together in start order, deduplicated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const html = await (
      await fixture([canonical(2, { discordEventId: null })], {
        rows: [
          transient("d-early", 1, "Early lobby night"),
          transient("d-late", 9, "Late lobby night"),
        ],
      }).request()
    ).text();
    const early = html.indexOf("Early lobby night");
    const canonicalIdx = html.indexOf("Game night 2");
    const late = html.indexOf("Late lobby night");
    expect(early).toBeGreaterThan(-1);
    expect(canonicalIdx).toBeGreaterThan(-1);
    expect(late).toBeGreaterThan(-1);
    expect(early).toBeLessThan(canonicalIdx);
    expect(canonicalIdx).toBeLessThan(late);
    expect(html).toContain('data-source="canonical"');
    expect(html).toContain('data-source="discord"');
    expect(html).toContain("/e/event-2");
  });

  it("suppresses the Discord duplicate when the canonical row carries the same Discord id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const html = await (
      await fixture([canonical(1, { title: "Synced community night", discordEventId: "d1" })], {
        rows: [transient("d1", 1, "Discord copy of synced night")],
      }).request()
    ).text();
    expect(html).toContain("Synced community night");
    expect(html).not.toContain("Discord copy of synced night");
    expect(html).toContain("/e/event-1");
  });

  it("shows the unavailable state when empty and the Discord read failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await fixture([], { rows: [], failed: true }).request();
    const html = await response.text();
    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain("Game nights are unavailable right now.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("shows the empty state when both sources are empty and the Discord read succeeded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const html = await (await fixture([], { rows: [], failed: false }).request()).text();
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("Nothing scheduled yet.");
  });

  it("still shows canonical rows when the Discord read failed (stale/error does not hide the schedule)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const html = await (await fixture([canonical(1)], { rows: [], failed: true }).request()).text();
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain("Game night 1");
    expect(html).not.toContain('data-state="unavailable"');
  });

  it("still renders canonical rows when the Discord read is slow (no schedule hide)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = fixture([canonical(1), canonical(2)]);
    Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
    const pending = loadHomeUpcomingMerged(
      async () => db,
      () => ({
        // A stale-snapshot refresh claimant holds the Discord read past the
        // homepage deadline; the teaser must still show the canonical rows.
        upcoming: () => new Promise<DiscordTransient[]>(() => {}),
        lastReadFailed: () => false,
      }),
      NOW,
    );
    await vi.advanceTimersByTimeAsync(HOME_DISCORD_TIMEOUT_MS + 100);
    const merged = await pending;
    expect(merged.items.map((r) => (r.source === "canonical" ? r.eventKey : null))).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(merged.unavailable).toBe(false);
    expect(merged.discordFailed).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders Discord-only rows in the past-rows zone like /events, not UTC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // No canonical upcoming rows; one ended London row sets the community
    // modal zone the same way /events' past drawer does.
    const past = canonical(99, {
      eventKey: "past-night",
      title: "Past community night",
      startsAt: new Date(NOW.getTime() - 48 * 3600_000),
      endsAt: new Date(NOW.getTime() - 46 * 3600_000),
      timezone: "Europe/London",
    });
    const html = await (
      await fixture([past], { rows: [transient("d1", 5, "Friday community games")] }).request()
    ).text();
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain("Friday community games");
    // 23:00Z is 00:00 next-day in London (BST); UTC would render 23:00 same-day.
    expect(html).toContain("(Europe/London)");
    expect(html).not.toContain("(UTC)");
  });

  it("loader returns unavailable on DB outage without leaking driver text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const merged = await loadHomeUpcomingMerged(
      async () => {
        throw new Error("postgres://user:secret@host/db");
      },
      () => ({ upcoming: async () => [], lastReadFailed: () => false }),
      NOW,
    );
    expect(merged).toEqual({ items: [], unavailable: true, discordFailed: false });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Home events unavailable; serving the fallback.", {
      exception: "ReadFailure",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("postgres://");
  });

  it("loader degrades at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = loadHomeUpcomingMerged(
      () => new Promise(() => {}),
      () => ({ upcoming: async () => [], lastReadFailed: () => false }),
      NOW,
    );
    await vi.advanceTimersByTimeAsync(HOME_EVENTS_DB_TIMEOUT_MS + 1000);
    expect(await pending).toEqual({ items: [], unavailable: true, discordFailed: false });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Home events unavailable; serving the fallback.", {
      exception: "HomeEventsDeadline",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
