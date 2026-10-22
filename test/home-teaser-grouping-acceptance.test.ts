// Homepage teaser grouping acceptance (Tonight / This week / Later).
//
// Owned by the teaser-grouping acceptance handoff: the paired build works
// from this branch and never edits this file; corrections return to the
// acceptance author. Local fixtures only: pg-proxy records real Drizzle SQL,
// Discord arrives through the in-memory seam, and the clock is frozen per
// case — no live fetch, no timer leak.
//
// Contract pinned here (the builder implements to these tests):
// - One shared helper, `src/events/teaser-groups.ts`, exporting
//   `groupTeaserEvents(rows, now)`. The Hono screen and the Kit home page
//   both import it; neither hand-rolls its own buckets.
// - Buckets are event-timezone calendar-day differences from `now`: tonight
//   is the same wall day (a past-start row clamps here, never drops),
//   this-week is 1-7 wall days ahead, later is 8+. Invalid zones read as
//   UTC. "This week" is a 7-day window, not a locale calendar week.
// - Groups render in tonight/this-week/later order with real h3 headings and
//   stable testids; empty groups are omitted; every input row renders exactly
//   once and "See all events" still links /events.
// - Empty/unavailable states, the 3-row cap, going counts, the Full marker
//   and Discord rows render exactly as today; grouping adds no reads.
//
// Most tests below are RED until the builder lands (missing helper and group
// blocks); the "unchanged behavior" controls stay green throughout.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { HOME_EVENTS_DB_TIMEOUT_MS } from "../src/events/reads";
import type { DiscordTransient } from "../src/islands/contracts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function rootFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

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

function instant(iso: string): Date {
  return new Date(iso);
}

function event(
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
    discordEventId: "discord-event-id",
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

function windowed(
  id: number,
  startsAt: string,
  overrides: Partial<typeof events.$inferSelect> = {},
): typeof events.$inferSelect {
  const start = instant(startsAt);
  return event(id, {
    startsAt: start,
    endsAt: new Date(start.getTime() + 7200_000),
    ...overrides,
  });
}

function transient(startsAt: string, discordId = "discord-99"): DiscordTransient {
  const start = instant(startsAt);
  return {
    discordId,
    status: "scheduled",
    title: `Discord game night ${discordId}`,
    description: "Discord public description",
    location: "Lobby voice room",
    startsAt: start,
    endsAt: new Date(start.getTime() + 7200_000),
  };
}

function fixture(
  rows: (typeof events.$inferSelect)[] = [],
  failAt?: "events" | "rsvps",
  discord?: { rows?: DiscordTransient[]; failed?: boolean },
  counts?: { named?: [number, number][]; occupied?: [number, number][] },
) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "featured_contents"')) return { rows: [] };
    if (sql.includes("set_config") && params[0] !== `${HOME_EVENTS_DB_TIMEOUT_MS}ms`)
      return { rows: [] };
    queries.push({ sql, params });
    if (sql.includes("set_config")) return { rows: [] };
    if (failAt && sql.includes(`from "${failAt}"`))
      throw new Error("postgres://user:secret@host/db private-member private-session");
    if (sql.includes('from "rsvps"')) {
      const named: [number, number][] = counts?.named ?? [
        [1, 2],
        [2, 1],
      ];
      const occupied = counts?.occupied ?? named;
      const countRows = (sql.includes('inner join "users"') ? named : occupied).filter(([id]) =>
        (params as unknown[]).includes(id),
      );
      return { rows: countRows };
    }
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) {
      return {
        rows: rows
          .filter((r) => r.discordEventId !== null && params.includes(r.discordEventId))
          .map((r) => [r.discordEventId]),
      };
    }
    if (sql.includes('"timezone"') && !sql.includes('"title"')) {
      const cutoff = new Date(
        String(params.find((p) => !Number.isNaN(Date.parse(String(p)))) ?? NOW),
      );
      const past = rows
        .filter((r) => r.status !== "draft" && r.endsAt < cutoff)
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || b.id - a.id)
        .slice(0, Number(params.at(-1) ?? 20));
      return { rows: past.map((r) => [r.timezone]) };
    }
    let selected = [...rows];
    if (sql.includes('"status" =')) selected = selected.filter((r) => r.status === params[0]);
    if (sql.includes('"ends_at" >='))
      selected = selected.filter((r) => r.endsAt >= new Date(String(params[1])));
    if (sql.includes('order by "events"."starts_at" asc')) {
      selected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
    }
    if (sql.includes("limit")) selected = selected.slice(0, Number(params.at(-1)));
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
  const discordRows = discord?.rows ?? [];
  const discordFailed = discord?.failed ?? false;
  const env = {
    ...baseEnv,
    ADMIN_DB: db,
    DISCORD_EVENTS: {
      upcoming: async () => discordRows,
      lastReadFailed: () => discordFailed,
    },
  } as Env;
  return {
    db,
    env,
    queries,
    request: () => app.request("/", {}, env),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function freezeNow(at: Date = NOW): void {
  vi.useFakeTimers();
  vi.setSystemTime(at);
}

type TeaserGroupKey = "tonight" | "this-week" | "later";

const GROUP_TESTIDS: Record<TeaserGroupKey, string> = {
  tonight: "home-events-group-tonight",
  "this-week": "home-events-group-this-week",
  later: "home-events-group-later",
};

const GROUP_LABELS: Record<TeaserGroupKey, string> = {
  tonight: "Tonight",
  "this-week": "This week",
  later: "Later",
};

/** The group block for `key`, cut at the next group block or "See all events". */
function groupSlice(html: string, key: TeaserGroupKey): string {
  const start = html.indexOf(`data-testid="${GROUP_TESTIDS[key]}"`);
  if (start === -1) throw new Error(`missing group block for ${key}`);
  const rest = html.slice(start);
  const ends: number[] = [];
  for (const other of Object.keys(GROUP_TESTIDS) as TeaserGroupKey[]) {
    if (other === key) continue;
    const at = rest.indexOf(`data-testid="${GROUP_TESTIDS[other]}"`, 1);
    if (at !== -1) ends.push(at);
  }
  const seeAll = rest.indexOf("See all events");
  if (seeAll !== -1) ends.push(seeAll);
  return ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest;
}

function expectGroupHeading(slice: string, key: TeaserGroupKey): void {
  expect(slice).toMatch(new RegExp(`<h3[^>]*>\\s*${GROUP_LABELS[key]}\\s*</h3>`));
}

function groupCardCount(html: string, key: TeaserGroupKey): number {
  return (groupSlice(html, key).match(/<li class="card"/g) ?? []).length;
}

/** Every teaser card between the list marker and "See all events". */
function teaserCardCount(html: string): number {
  const listAt = html.indexOf('data-testid="home-events-list"');
  if (listAt === -1) throw new Error("missing home-events-list");
  const seeAll = html.indexOf("See all events", listAt);
  if (seeAll === -1) throw new Error("missing See all events link");
  return (html.slice(listAt, seeAll).match(/<li class="card"/g) ?? []).length;
}

/** The one card linking `eventKey` inside the group for `key`. */
function groupTeaserRow(html: string, key: TeaserGroupKey, eventKey: string): string {
  const slice = groupSlice(html, key);
  const hit = slice.split('<li class="card"').find((chunk) => chunk.includes(`/e/${eventKey}"`));
  if (!hit) throw new Error(`no ${eventKey} row under ${key}`);
  return hit.split("</li>")[0]!;
}

describe("teaser grouping acceptance: Hono grouped render", () => {
  it("groups three upcoming rows into Tonight / This week / Later in start order", async () => {
    freezeNow();
    const f = fixture([
      windowed(1, "2030-07-04T19:00:00Z"),
      windowed(2, "2030-07-05T10:00:00Z"),
      windowed(3, "2030-07-13T10:00:00Z"),
    ]);
    const html = await (await f.request()).text();
    expect(html).toContain('data-testid="home-events-list"');
    const tonightAt = html.indexOf(`data-testid="${GROUP_TESTIDS.tonight}"`);
    const weekAt = html.indexOf(`data-testid="${GROUP_TESTIDS["this-week"]}"`);
    const laterAt = html.indexOf(`data-testid="${GROUP_TESTIDS.later}"`);
    expect(tonightAt).toBeGreaterThan(-1);
    expect(weekAt).toBeGreaterThan(tonightAt);
    expect(laterAt).toBeGreaterThan(weekAt);
    expectGroupHeading(groupSlice(html, "tonight"), "tonight");
    expectGroupHeading(groupSlice(html, "this-week"), "this-week");
    expectGroupHeading(groupSlice(html, "later"), "later");
    expect(groupSlice(html, "tonight")).toContain("Game night 1");
    expect(groupSlice(html, "tonight")).toContain('href="/e/event-1"');
    expect(groupSlice(html, "this-week")).toContain("Game night 2");
    expect(groupSlice(html, "later")).toContain("Game night 3");
    // Total count and the all-events link survive grouping.
    expect(teaserCardCount(html)).toBe(3);
    expect(html).toContain('href="/events"');
    expect(html).toContain("See all events");
    // Row content is unchanged: wall time, zone, going aggregate.
    expect(groupSlice(html, "tonight")).toContain("Thu 4 Jul, 20:00 (Europe/London)");
    expect(groupSlice(html, "this-week")).toContain("Fri 5 Jul, 11:00 (Europe/London)");
    expect(groupSlice(html, "tonight")).toContain("2 going");
    expect(groupSlice(html, "later")).toContain("0 going");
    expect(html).not.toContain('data-testid="home-events-empty"');
  });

  it("splits a midnight boundary: 23:59 tonight, 00:01 this week", async () => {
    freezeNow(instant("2030-07-04T23:30:00Z"));
    const f = fixture([
      windowed(1, "2030-07-04T23:59:00Z", { timezone: "UTC" }),
      windowed(2, "2030-07-05T00:01:00Z", { timezone: "UTC" }),
    ]);
    const html = await (await f.request()).text();
    expect(groupSlice(html, "tonight")).toContain("Game night 1");
    expect(groupSlice(html, "this-week")).toContain("Game night 2");
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS.later}"`);
    expect(teaserCardCount(html)).toBe(2);
  });

  it("rolls This week into Later at the 7 to 8 day boundary", async () => {
    freezeNow();
    const f = fixture([
      windowed(1, "2030-07-04T19:00:00Z", { timezone: "UTC" }),
      windowed(2, "2030-07-11T18:00:00Z", { timezone: "UTC" }),
      windowed(3, "2030-07-12T18:00:00Z", { timezone: "UTC" }),
    ]);
    const html = await (await f.request()).text();
    expect(groupSlice(html, "tonight")).toContain("Game night 1");
    expect(groupSlice(html, "this-week")).toContain("Game night 2");
    expect(groupSlice(html, "later")).toContain("Game night 3");
  });

  it("buckets a DST fall-back day by calendar, not by 24-hour arithmetic", async () => {
    // US Eastern falls back on 2030-11-03 (02:00 EDT -> 01:00 EST): the event
    // starts 24 hours after `now` on the same wall day, so it is tonight.
    freezeNow(instant("2030-11-03T04:30:00Z"));
    const f = fixture([
      windowed(1, "2030-11-04T04:30:00Z", { timezone: "America/New_York" }),
      windowed(2, "2030-11-12T12:00:00Z", { timezone: "America/New_York" }),
    ]);
    const html = await (await f.request()).text();
    expect(groupSlice(html, "tonight")).toContain("Game night 1");
    expect(groupSlice(html, "later")).toContain("Game night 2");
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS["this-week"]}"`);
  });

  it("buckets each event in its own timezone, not the viewer's", async () => {
    // The same instant is Jun 2 in UTC (tomorrow) but still Jun 2 midday in
    // Auckland where `now` already reads Jun 2, so the rows split.
    freezeNow(instant("2030-06-01T23:30:00Z"));
    const f = fixture([
      windowed(1, "2030-06-02T00:30:00Z", { timezone: "UTC" }),
      windowed(2, "2030-06-02T00:30:00Z", { timezone: "Pacific/Auckland" }),
    ]);
    const html = await (await f.request()).text();
    expect(groupSlice(html, "this-week")).toContain("Game night 1");
    expect(groupSlice(html, "tonight")).toContain("Game night 2");
  });

  it("reads an invalid zone as UTC for both bucket and label", async () => {
    freezeNow();
    const f = fixture([
      windowed(1, "2030-07-04T19:00:00Z", { timezone: "UTC" }),
      windowed(2, "2030-07-05T10:00:00Z", { timezone: "Invalid/Zone" }),
    ]);
    const html = await (await f.request()).text();
    expect(groupSlice(html, "tonight")).toContain("Game night 1");
    const week = groupSlice(html, "this-week");
    expect(week).toContain("Game night 2");
    expect(week).toContain("(UTC)");
    expect(html).not.toContain("Invalid/Zone");
  });

  it("omits empty groups when every row lands tonight", async () => {
    freezeNow();
    const f = fixture([windowed(1, "2030-07-04T19:00:00Z"), windowed(2, "2030-07-04T20:00:00Z")]);
    const html = await (await f.request()).text();
    expect(html).toContain(`data-testid="${GROUP_TESTIDS.tonight}"`);
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS["this-week"]}"`);
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS.later}"`);
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain("See all events");
    expect(teaserCardCount(html)).toBe(2);
  });

  it("renders a lone later row under its own heading with list and link intact", async () => {
    freezeNow();
    const f = fixture([windowed(1, "2030-07-13T10:00:00Z")]);
    const html = await (await f.request()).text();
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS.tonight}"`);
    expect(html).not.toContain(`data-testid="${GROUP_TESTIDS["this-week"]}"`);
    expectGroupHeading(groupSlice(html, "later"), "later");
    expect(groupSlice(html, "later")).toContain("Game night 1");
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain("See all events");
    expect(teaserCardCount(html)).toBe(1);
  });

  it("keeps the 3-row cap across groups: the fourth soonest row never renders", async () => {
    freezeNow();
    const f = fixture([
      windowed(1, "2030-07-04T19:00:00Z"),
      windowed(2, "2030-07-04T20:00:00Z"),
      windowed(3, "2030-07-05T10:00:00Z"),
      windowed(4, "2030-07-05T12:00:00Z"),
    ]);
    const html = await (await f.request()).text();
    expect(html).not.toContain("Game night 4");
    expect(groupCardCount(html, "tonight")).toBe(2);
    expect(groupCardCount(html, "this-week")).toBe(1);
    expect(teaserCardCount(html)).toBe(3);
  });

  it("groups Discord snapshot rows with canonical rows and keeps the RSVP copy", async () => {
    freezeNow();
    const f = fixture(
      [windowed(1, "2030-07-04T19:00:00Z"), windowed(2, "2030-07-13T10:00:00Z")],
      undefined,
      { rows: [transient("2030-07-05T10:00:00Z")] },
    );
    const html = await (await f.request()).text();
    expect(groupSlice(html, "tonight")).toContain("Game night 1");
    const week = groupSlice(html, "this-week");
    expect(week).toContain('data-testid="home-event-discord"');
    expect(week).toContain("RSVP in Discord");
    expect(week).toContain('href="https://discord.gg/invite"');
    expect(groupSlice(html, "later")).toContain("Game night 2");
    expect(teaserCardCount(html)).toBe(3);
  });

  it("keeps going counts and the Full marker scoped to their grouped rows", async () => {
    freezeNow();
    const f = fixture(
      [
        windowed(1, "2030-07-04T19:00:00Z", { capacity: 2 }),
        windowed(2, "2030-07-05T10:00:00Z", { capacity: 4 }),
        windowed(3, "2030-07-13T10:00:00Z", { capacity: null }),
      ],
      undefined,
      undefined,
      {
        named: [
          [1, 1],
          [2, 1],
        ],
        occupied: [
          [1, 2],
          [2, 1],
        ],
      },
    );
    const html = await (await f.request()).text();
    const full = groupTeaserRow(html, "tonight", "event-1");
    expect(full).toContain("1 of 2 going");
    expect(full).toContain('data-testid="event-spots-left"');
    expect(full).toContain(">Full<");
    const open = groupTeaserRow(html, "this-week", "event-2");
    expect(open).toContain("1 of 4 going");
    expect(open).not.toContain("event-spots-left");
    expect(groupTeaserRow(html, "later", "event-3")).toContain("0 going");
  });

  it("renders grouped with no client script: group blocks carry no island", async () => {
    freezeNow();
    const f = fixture([
      windowed(1, "2030-07-04T19:00:00Z"),
      windowed(2, "2030-07-05T10:00:00Z"),
      windowed(3, "2030-07-13T10:00:00Z"),
    ]);
    const html = await (await f.request()).text();
    for (const key of Object.keys(GROUP_TESTIDS) as TeaserGroupKey[]) {
      expect(groupSlice(html, key)).not.toContain("data-island");
    }
    expect(html).not.toContain("data-island");
  });
});

describe("teaser grouping acceptance: unchanged behavior controls", () => {
  it("shows the empty state with no groups and no list when nothing is scheduled", async () => {
    freezeNow();
    const html = await (await fixture().request()).text();
    expect(html).toContain('data-testid="home-events-empty"');
    expect(html).toContain('data-state="empty"');
    expect(html).toContain("Nothing scheduled yet.");
    expect(html).not.toContain('data-testid="home-events-list"');
    for (const key of Object.keys(GROUP_TESTIDS) as TeaserGroupKey[]) {
      expect(html).not.toContain(`data-testid="${GROUP_TESTIDS[key]}"`);
    }
    expect(html).toMatch(/href="\/join"[^>]*data-testid="home-events-join"/);
  });

  it("degrades to unavailable with no groups when the events read rejects", async () => {
    freezeNow();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await fixture([windowed(1, "2030-07-04T19:00:00Z")], "events").request();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="home-events-empty"');
    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain("Game nights are unavailable right now.");
    expect(html).not.toContain('data-testid="home-events-list"');
    for (const key of Object.keys(GROUP_TESTIDS) as TeaserGroupKey[]) {
      expect(html).not.toContain(`data-testid="${GROUP_TESTIDS[key]}"`);
    }
  });

  it("adds no reads: grouped rendering only touches the existing teaser queries", async () => {
    freezeNow();
    const f = fixture([
      windowed(1, "2030-07-04T19:00:00Z"),
      windowed(2, "2030-07-05T10:00:00Z"),
      windowed(3, "2030-07-13T10:00:00Z"),
    ]);
    const html = await (await f.request()).text();
    expect(html).toContain('data-testid="home-events-list"');
    const canonical = f.queries.find(
      (q) => q.sql.includes('from "events"') && q.sql.includes('"title"'),
    );
    expect(canonical?.sql).toContain("limit");
    expect(canonical?.params.at(-1)).toBe(3);
    expect(f.queries.length).toBeGreaterThan(0);
    for (const query of f.queries) {
      expect(
        query.sql,
        `grouping must add no reads (unexpected query: ${query.sql.slice(0, 120)})`,
      ).toMatch(/set_config|from "events"|from "rsvps"|featured_contents/);
    }
  });
});

const TEASER_GROUPS_SPECIFIER: string = "../src/events/teaser-groups";

interface TeaserInputRow {
  startsAt: Date;
  timezone: string;
  title: string;
}

interface TeaserGroup {
  key: TeaserGroupKey;
  label: string;
  events: TeaserInputRow[];
}

type GroupTeaserEvents = (rows: TeaserInputRow[], now: Date) => TeaserGroup[];

async function loadGrouper(): Promise<GroupTeaserEvents> {
  let mod: unknown = null;
  try {
    mod = (await import(TEASER_GROUPS_SPECIFIER)) as unknown;
  } catch {
    mod = null;
  }
  expect(
    mod,
    "shared helper src/events/teaser-groups.ts is missing: the builder has not landed it yet",
  ).toBeTruthy();
  const fn = (mod as { groupTeaserEvents?: unknown }).groupTeaserEvents;
  expect(
    typeof fn,
    "src/events/teaser-groups.ts must export a groupTeaserEvents(rows, now) function",
  ).toBe("function");
  return fn as GroupTeaserEvents;
}

function inputRow(startsAt: string, timezone: string, title: string): TeaserInputRow {
  return { startsAt: instant(startsAt), timezone, title };
}

function bucketOf(groups: TeaserGroup[], title: string): TeaserGroupKey {
  const hit = groups.find((group) => group.events.some((row) => row.title === title));
  if (!hit) throw new Error(`no bucket for ${title}`);
  return hit.key;
}

function bucketOfStart(groups: TeaserGroup[], startsAt: Date): TeaserGroupKey {
  const hit = groups.find((group) =>
    group.events.some((row) => row.startsAt.getTime() === startsAt.getTime()),
  );
  if (!hit) throw new Error(`no bucket for ${startsAt.toISOString()}`);
  return hit.key;
}

/** Sealed rows prove the helper buckets from startsAt/timezone alone. */
function sealedRow(startsAt: Date, timezone: string, title: string): TeaserInputRow {
  const target: TeaserInputRow = { startsAt, timezone, title };
  return new Proxy(target, {
    get(t, p, r) {
      if (p === "startsAt" || p === "timezone" || typeof p === "symbol") {
        return Reflect.get(t, p, r);
      }
      throw new Error(
        `groupTeaserEvents must bucket from startsAt/timezone only (read ${String(p)}); pass rows through by reference`,
      );
    },
  });
}

function zoneOffsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const wall = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")) % 24,
    Number(get("minute")),
    Number(get("second")),
  );
  return Math.round((wall - at.getTime()) / 60000);
}

describe("teaser grouping acceptance: shared helper units", () => {
  it("buckets tonight, this-week and later with stable keys, labels and order", async () => {
    const group = await loadGrouper();
    const groups = group(
      [
        inputRow("2030-07-04T19:00:00Z", "Europe/London", "tonight"),
        inputRow("2030-07-05T10:00:00Z", "Europe/London", "week"),
        inputRow("2030-07-13T10:00:00Z", "Europe/London", "later"),
      ],
      NOW,
    );
    expect(groups.map((g) => g.key)).toEqual(["tonight", "this-week", "later"]);
    expect(groups.map((g) => g.label)).toEqual(["Tonight", "This week", "Later"]);
    expect(bucketOf(groups, "tonight")).toBe("tonight");
    expect(bucketOf(groups, "week")).toBe("this-week");
    expect(bucketOf(groups, "later")).toBe("later");
    expect(groups.flatMap((g) => g.events)).toHaveLength(3);
  });

  it("returns no groups for no rows and a lone group when one bucket fills", async () => {
    const group = await loadGrouper();
    expect(group([], NOW)).toEqual([]);
    const lone = group([inputRow("2030-07-13T10:00:00Z", "UTC", "later")], NOW);
    expect(lone.map((g) => g.key)).toEqual(["later"]);
    expect(lone[0]?.events.map((row) => row.title)).toEqual(["later"]);
  });

  it("puts an exact-midnight start on the next day, never tonight", async () => {
    const group = await loadGrouper();
    const now = instant("2030-07-04T23:30:00Z");
    const groups = group(
      [
        inputRow("2030-07-04T23:59:00Z", "UTC", "late"),
        inputRow("2030-07-05T00:00:00Z", "UTC", "midnight"),
      ],
      now,
    );
    expect(bucketOf(groups, "late")).toBe("tonight");
    expect(bucketOf(groups, "midnight")).toBe("this-week");
  });

  it("buckets the same instant per event zone: UTC tomorrow, Auckland tonight", async () => {
    const group = await loadGrouper();
    const groups = group(
      [
        inputRow("2030-06-02T00:30:00Z", "UTC", "utc"),
        inputRow("2030-06-02T00:30:00Z", "Pacific/Auckland", "auckland"),
      ],
      instant("2030-06-01T23:30:00Z"),
    );
    expect(bucketOf(groups, "utc")).toBe("this-week");
    expect(bucketOf(groups, "auckland")).toBe("tonight");
  });

  it("keeps day 7 in This week and moves day 8 to Later", async () => {
    const group = await loadGrouper();
    const groups = group(
      [
        inputRow("2030-07-11T18:00:00Z", "UTC", "day-7"),
        inputRow("2030-07-12T18:00:00Z", "UTC", "day-8"),
      ],
      NOW,
    );
    expect(bucketOf(groups, "day-7")).toBe("this-week");
    expect(bucketOf(groups, "day-8")).toBe("later");
  });

  it("follows the wall calendar across DST transitions, not hour counts", async () => {
    const group = await loadGrouper();
    // Spring forward (US Eastern 2030-03-10): 23 hours apart, adjacent days.
    const springNow = instant("2030-03-09T17:00:00Z");
    const springRow = instant("2030-03-10T16:00:00Z");
    expect(zoneOffsetMinutes(springNow, "America/New_York")).toBe(-300);
    expect(zoneOffsetMinutes(springRow, "America/New_York")).toBe(-240);
    expect(springRow.getTime() - springNow.getTime()).toBe(23 * 3600_000);
    const spring = group(
      [inputRow("2030-03-10T16:00:00Z", "America/New_York", "spring")],
      springNow,
    );
    expect(bucketOf(spring, "spring")).toBe("this-week");
    // Fall back (US Eastern 2030-11-03): 24 hours apart, the same wall day.
    const fallNow = instant("2030-11-03T04:30:00Z");
    const fallRow = instant("2030-11-04T04:30:00Z");
    expect(zoneOffsetMinutes(fallNow, "America/New_York")).toBe(-240);
    expect(zoneOffsetMinutes(fallRow, "America/New_York")).toBe(-300);
    expect(fallRow.getTime() - fallNow.getTime()).toBe(24 * 3600_000);
    const fall = group([inputRow("2030-11-04T04:30:00Z", "America/New_York", "fall")], fallNow);
    expect(bucketOf(fall, "fall")).toBe("tonight");
  });

  it("reads invalid zones as UTC", async () => {
    const group = await loadGrouper();
    const groups = group(
      [
        inputRow("2030-07-04T19:00:00Z", "Invalid/Zone", "tonight"),
        inputRow("2030-07-05T10:00:00Z", "Invalid/Zone", "week"),
      ],
      NOW,
    );
    expect(bucketOf(groups, "tonight")).toBe("tonight");
    expect(bucketOf(groups, "week")).toBe("this-week");
  });

  it("clamps a past-start row to tonight instead of dropping it", async () => {
    const group = await loadGrouper();
    const groups = group([inputRow("2030-07-03T20:00:00Z", "UTC", "in-progress")], NOW);
    expect(groups.map((g) => g.key)).toEqual(["tonight"]);
    expect(bucketOf(groups, "in-progress")).toBe("tonight");
  });

  it("buckets from startsAt and timezone alone, never another row field", async () => {
    const group = await loadGrouper();
    const late = instant("2030-07-04T19:00:00Z");
    const week = instant("2030-07-05T10:00:00Z");
    const later = instant("2030-07-13T10:00:00Z");
    const groups = group(
      [
        sealedRow(late, "Europe/London", "tonight"),
        sealedRow(week, "Europe/London", "week"),
        sealedRow(later, "Europe/London", "later"),
      ],
      NOW,
    );
    expect(bucketOfStart(groups, late)).toBe("tonight");
    expect(bucketOfStart(groups, week)).toBe("this-week");
    expect(bucketOfStart(groups, later)).toBe("later");
  });

  it("preserves input order inside a bucket instead of re-sorting", async () => {
    const group = await loadGrouper();
    const groups = group(
      [
        inputRow("2030-07-04T20:00:00Z", "UTC", "second"),
        inputRow("2030-07-04T19:00:00Z", "UTC", "first"),
      ],
      NOW,
    );
    expect(groups.map((g) => g.key)).toEqual(["tonight"]);
    expect(groups[0]?.events.map((row) => row.title)).toEqual(["second", "first"]);
  });
});

describe("teaser grouping acceptance: shared module pins", () => {
  it("keeps the grouping helper in one shared module", () => {
    let helper: string | null = null;
    try {
      helper = rootFile("src/events/teaser-groups.ts");
    } catch {
      helper = null;
    }
    expect(helper, "the builder has not added src/events/teaser-groups.ts yet").toBeTruthy();
    expect(helper as string).toContain("groupTeaserEvents");
  });

  it("shares the helper between the Hono screen and the Kit home page", () => {
    const home = rootFile("src/screens/home.tsx");
    expect(
      home,
      "src/screens/home.tsx must import groupTeaserEvents from the shared module",
    ).toMatch(
      /import\s*\{[^}]*groupTeaserEvents[^}]*\}\s*from\s*["'][^"']*teaser-groups[^"']*["']/,
    );
    const page = rootFile("web/src/routes/+page.svelte");
    expect(
      page,
      "web/src/routes/+page.svelte must import groupTeaserEvents from the shared module",
    ).toMatch(
      /import\s*\{[^}]*groupTeaserEvents[^}]*\}\s*from\s*["'][^"']*teaser-groups[^"']*["']/,
    );
  });

  it("keeps the helper free of reads: no database, fetch or environment", () => {
    let helper: string | null = null;
    try {
      helper = rootFile("src/events/teaser-groups.ts");
    } catch {
      helper = null;
    }
    expect(helper, "the builder has not added src/events/teaser-groups.ts yet").toBeTruthy();
    const src = helper as string;
    const specifiers = [...src.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((spec): spec is string => typeof spec === "string");
    for (const spec of specifiers) {
      expect(
        spec === "./date-format" ||
          spec === "./reads" ||
          spec.includes("islands/contracts") ||
          spec.startsWith("node:"),
        `helper must stay framework-free (unexpected import ${spec})`,
      ).toBe(true);
    }
    for (const forbidden of ["fetch(", "DATABASE_URL", "process.env", "drizzle", "postgres"]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
