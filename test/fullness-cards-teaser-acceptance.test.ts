// F3 acceptance: full events are marked on calendar cards and the home teaser.
//
// Owned by the F3 acceptance card: the paired build works from this branch
// and never edits this file; corrections return to the acceptance card.
// Local fixtures only: pg-proxy fakes record real Drizzle SQL, no database.
//
// Contract pinned here (mirrors the event-detail lineup):
// - `listHomeUpcoming` rows carry `capacity`; the teaser renders capped rows
//   as "N of M going" via the shared `goingCountText` helper.
// - A full row carries the same Full marker as detail: the `event-spots-left`
//   node rendering "Full".
// - The card full verdict reads seat occupancy (`goingOccupancy`), never the
//   attributable count alone, so a card never offers a seat the write path
//   cannot grant. The teaser verdict reads the attributable `goingCount` it
//   carries: `HomeEvent` gains capacity only, not occupancy.
// - Uncapped rows render exactly as today (bare "N going", no marker node);
//   past-drawer and archive cards are untouched by the build.
//
// route-inventory: GET /events
// route-inventory: GET /events/past
// route-inventory: GET /
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients-types";
import { listHomeUpcoming } from "../src/events/reads";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

type EventRow = typeof events.$inferSelect;

let eventSeq = 0;
function eventRow(over: Partial<EventRow> = {}): EventRow {
  const n = ++eventSeq;
  const start = over.startsAt ?? new Date(Date.UTC(2030, 6, 10 + n, 19));
  const end = over.endsAt ?? new Date(start.getTime() + 7200_000);
  return {
    id: n,
    icsSequence: 1n,
    eventKey: `fullness-${n}`,
    // The title must not contain "Full": negative marker pins assert on it.
    title: `Game night ${n}`,
    game: null,
    description: null,
    startsAt: start,
    endsAt: end,
    timezone: "Europe/London",
    location: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
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
    createdAt: start,
    updatedAt: start,
    syncRevision: 1,
    syncedRevision: 0,
    ...over,
  };
}

/** A past event for the drawer/archive reads: ended long before any test now. */
function pastEventRow(over: Partial<EventRow> = {}): EventRow {
  const end = new Date(Date.UTC(2020, 5, 10, 22));
  return eventRow({
    startsAt: new Date(end.getTime() - 7200_000),
    endsAt: end,
    ...over,
  });
}

interface GoingCounts {
  /** Attributable (named-only) count, like the roster length. */
  named: number;
  /** Seat occupancy: every going row, like the write path. */
  occupied: number;
}

function calendarFixture(upcoming: EventRow[], past: EventRow[], counts: Map<number, GoingCounts>) {
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const encode = (row: EventRow) =>
    columns.map((key) => {
      const value = row[key];
      return value instanceof Date ? value.toISOString() : value;
    });
  const countRows = (sql: string, params: unknown[], pick: (c: GoingCounts) => number) => ({
    rows: [...counts]
      .filter(([id]) => (params as unknown[]).includes(id))
      .map(([id, c]) => [id, pick(c)]),
  });
  const db = drizzle(async (sql: string, params: unknown[]) => {
    if (sql.startsWith("select distinct")) {
      const games = [
        ...new Set(
          [...upcoming, ...past]
            .filter((row) => row.status === "published")
            .map((row) => row.game?.trim())
            .filter((game): game is string => !!game),
        ),
      ];
      return { rows: games.slice(0, Number(params.at(-1))).map((game) => [game]) };
    }
    if (sql.includes('from "rsvps"')) {
      if (!sql.includes("count(*)")) return { rows: [] };
      // The attributable aggregate joins users; the occupancy aggregate reads
      // every going row, so the join distinguishes the two batched counts.
      // The combined aggregate merges both sides into (event_id, named,
      // occupied) rows.
      if (sql.includes('left join "users"') && sql.includes("group by"))
        return {
          rows: [...counts]
            .filter(([id]) => (params as unknown[]).includes(id))
            .map(([id, c]) => [id, c.named, c.occupied]),
        };
      return sql.includes('inner join "users"')
        ? countRows(sql, params, (c) => c.named)
        : countRows(sql, params, (c) => c.occupied);
    }
    if (sql.startsWith('select "discord_event_id" from "events"')) return { rows: [] };
    // Ended-row probes (past drawer, archive count/select) filter ends_at < now;
    // upcoming probes filter ends_at >= now. Draft filtering follows the query.
    if (sql.includes("count(*)")) {
      const rows = sql.includes('"ends_at" <') ? past : upcoming;
      return { rows: [[rows.length]] };
    }
    const rows = sql.includes('"ends_at" <') ? past : upcoming;
    const visible = sql.includes("'draft'") ? rows.filter((r) => r.status !== "draft") : rows;
    return { rows: visible.map(encode) };
  });
  const source: DiscordEventsSource = {
    upcoming: async () => [],
    lastReadFailed: () => false,
  };
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: source,
  } as unknown as Env;
  return {
    env,
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
}

function teaserFixture(rows: EventRow[], counts: Map<number, GoingCounts>) {
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const db = drizzle(async (sql: string, params: unknown[]) => {
    if (sql.includes('from "featured_contents"')) return { rows: [] };
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('from "rsvps"')) {
      if (sql.includes('left join "users"') && sql.includes("group by")) {
        return {
          rows: [...counts]
            .filter(([id]) => (params as unknown[]).includes(id))
            .map(([id, c]) => [id, c.named, c.occupied]),
        };
      }
      return {
        rows: [...counts]
          .filter(([id]) => (params as unknown[]).includes(id))
          .map(([id, c]) => [id, sql.includes('inner join "users"') ? c.named : c.occupied]),
      };
    }
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes('"timezone"') && !sql.includes('"title"')) return { rows: [] };
    // Honor the query's bound status, boundary and cap like the reader suite.
    let selected = [...rows];
    if (sql.includes('"status" ='))
      selected = selected.filter((r) => r.status === (params as unknown[])[0]);
    if (sql.includes('"ends_at" >='))
      selected = selected.filter((r) => r.endsAt >= new Date(String((params as unknown[])[1])));
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
  // pg-proxy has no transactions; run the callback on this SQL-recording fixture.
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET,
    ADMIN_DB: db,
    DISCORD_EVENTS: {
      upcoming: async () => [],
      lastReadFailed: () => false,
    },
  } as unknown as Env;
  return {
    db,
    env,
    request: () => app.request("/", {}, env),
  };
}

/** The one calendar card for `key`, so a sibling's marker cannot satisfy the pin. */
function calendarCard(html: string, key: string): string {
  const hit = html.split("<article").find((chunk) => chunk.includes(`data-event-key="${key}"`));
  if (!hit) throw new Error(`no calendar card for ${key}`);
  return hit.split("</article>")[0]!;
}

/** The one teaser row for `key`, scoped like the card pin above. */
function teaserRow(html: string, key: string): string {
  const hit = html.split('<li class="card"').find((chunk) => chunk.includes(`/e/${key}"`));
  if (!hit) throw new Error(`no teaser row for ${key}`);
  return hit.split("</li>")[0]!;
}

/** The one archive card for `key`. */
function archiveCard(html: string, key: string): string {
  const hit = html.split("<li").find((chunk) => chunk.includes(`data-event-key="${key}"`));
  if (!hit) throw new Error(`no archive card for ${key}`);
  return hit.split("</li>")[0]!;
}

beforeEach(() => {
  __resetAnonEventCacheForTests();
});

describe("F3 fullness acceptance: teaser rows carry capacity", () => {
  it("returns capacity on every teaser row, null when uncapped", async () => {
    const capped = eventRow({ capacity: 10 });
    const uncapped = eventRow({ capacity: null });
    const f = teaserFixture(
      [capped, uncapped],
      new Map([
        [capped.id, { named: 2, occupied: 2 }],
        [uncapped.id, { named: 3, occupied: 3 }],
      ]),
    );
    const rows = await listHomeUpcoming(f.db, new Date(Date.UTC(2030, 0, 1)));
    expect(rows.map((r) => r.eventKey)).toEqual([capped.eventKey, uncapped.eventKey]);
    expect(Object.keys(rows[0]!).sort()).toContain("capacity");
    const capacities = rows.map((r) => (r as unknown as { capacity: number | null }).capacity);
    expect(capacities).toEqual([10, null]);
  });
});

describe("F3 fullness acceptance: calendar cards", () => {
  it("marks a full capped card with the Full marker plus testid", async () => {
    const full = eventRow({ capacity: 2 });
    const src = calendarFixture([full], [], new Map([[full.id, { named: 2, occupied: 2 }]]));
    const html = await (await src.request("/events")).text();
    const card = calendarCard(html, full.eventKey);
    expect(card).toContain("2 of 2 going");
    expect(card).toContain('data-testid="event-spots-left"');
    expect(card).toContain(">Full<");
  });

  it("reads the card full verdict from seat occupancy, like the detail lineup", async () => {
    // One nameless going row holds the second seat: the attributable count
    // stays 1, but the write path cannot grant another seat, so the card is
    // full exactly like the detail lineup.
    const full = eventRow({ capacity: 2 });
    const src = calendarFixture([full], [], new Map([[full.id, { named: 1, occupied: 2 }]]));
    const html = await (await src.request("/events")).text();
    const card = calendarCard(html, full.eventKey);
    expect(card).toContain("1 of 2 going");
    expect(card).toContain('data-testid="event-spots-left"');
    expect(card).toContain(">Full<");
  });

  it("shows no Full marker on a capped card with seats left", async () => {
    const open = eventRow({ capacity: 4 });
    const full = eventRow({ capacity: 2 });
    const src = calendarFixture(
      [open, full],
      [],
      new Map([
        [open.id, { named: 1, occupied: 1 }],
        [full.id, { named: 2, occupied: 2 }],
      ]),
    );
    const html = await (await src.request("/events")).text();
    // The full sibling proves the negative below is scoped, not vacuous.
    expect(calendarCard(html, full.eventKey)).toContain("2 of 2 going");
    const card = calendarCard(html, open.eventKey);
    expect(card).toContain("1 of 4 going");
    expect(card).not.toContain("Full");
  });

  it("renders uncapped cards exactly as today: bare count, no marker node", async () => {
    const uncapped = eventRow({ capacity: null });
    const capped = eventRow({ capacity: 4 });
    const src = calendarFixture(
      [uncapped, capped],
      [],
      new Map([
        [uncapped.id, { named: 3, occupied: 3 }],
        [capped.id, { named: 1, occupied: 1 }],
      ]),
    );
    const html = await (await src.request("/events")).text();
    expect(calendarCard(html, capped.eventKey)).toContain("1 of 4 going");
    const card = calendarCard(html, uncapped.eventKey);
    expect(card).toContain("3 going");
    expect(card).not.toContain("event-spots-left");
  });

  it("leaves past-drawer cards unmarked even when full", async () => {
    const fullPast = pastEventRow({ capacity: 2 });
    const src = calendarFixture(
      [eventRow({ capacity: null })],
      [fullPast],
      new Map([[fullPast.id, { named: 2, occupied: 2 }]]),
    );
    const html = await (await src.request("/events?past=1")).text();
    const card = calendarCard(html, fullPast.eventKey);
    expect(card).toContain(fullPast.title);
    expect(card).toContain("Ended");
    expect(card).not.toContain("event-spots-left");
    expect(card).not.toContain("Full");
  });
});

describe("F3 fullness acceptance: archive cards stay untouched", () => {
  it("renders a full archived event with no marker node", async () => {
    const fullPast = pastEventRow({ capacity: 2 });
    const src = calendarFixture(
      [],
      [fullPast],
      new Map([[fullPast.id, { named: 2, occupied: 2 }]]),
    );
    const response = await src.request("/events/past");
    expect(response.status).toBe(200);
    const html = await response.text();
    const card = archiveCard(html, fullPast.eventKey);
    expect(card).toContain(fullPast.title);
    expect(card).toContain("2 of 2 going");
    expect(card).not.toContain("event-spots-left");
    expect(card).not.toContain("Full");
  });
});

describe("F3 fullness acceptance: Hono teaser", () => {
  it("renders capped teaser rows as N of M going", async () => {
    const capped = eventRow({ capacity: 10 });
    const f = teaserFixture([capped], new Map([[capped.id, { named: 2, occupied: 2 }]]));
    const html = await (await f.request()).text();
    expect(teaserRow(html, capped.eventKey)).toContain("2 of 10 going");
  });

  it("marks a full teaser row with the same Full marker plus testid", async () => {
    const full = eventRow({ capacity: 2 });
    const f = teaserFixture([full], new Map([[full.id, { named: 2, occupied: 2 }]]));
    const html = await (await f.request()).text();
    const row = teaserRow(html, full.eventKey);
    expect(row).toContain("2 of 2 going");
    expect(row).toContain('data-testid="event-spots-left"');
    expect(row).toContain(">Full<");
  });

  it("renders uncapped teaser rows exactly as today: bare count, no marker", async () => {
    const uncapped = eventRow({ capacity: null });
    const capped = eventRow({ capacity: 4 });
    const f = teaserFixture(
      [uncapped, capped],
      new Map([
        [uncapped.id, { named: 3, occupied: 3 }],
        [capped.id, { named: 1, occupied: 1 }],
      ]),
    );
    const html = await (await f.request()).text();
    // The capped sibling proves the negative below is scoped, not vacuous;
    // its own count format is pinned above, so only presence is asserted here.
    expect(teaserRow(html, capped.eventKey)).toContain(capped.title);
    const row = teaserRow(html, uncapped.eventKey);
    expect(row).toContain("3 going");
    expect(row).not.toContain("event-spots-left");
  });

  it("renders the teaser count via the shared goingCountText helper", () => {
    // The teaser must not paste its own "N of M going" copy: one helper keeps
    // cards, teasers and detail on the same words.
    expect(read("src/screens/home.tsx")).toContain("goingCountText");
  });
});
