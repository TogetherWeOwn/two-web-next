// Acceptance tests for the /events concurrent calendar reads change (#871):
// the list-view reads (upcoming page, past drawer, Discord transients) are
// independent, so they must start together instead of summing every round
// trip into /events server time. This suite is hermetic: a pg-proxy fake DB
// plus a stub Discord source — no database, no browser, no network.
//
// Rows:
//  A1 list view: past + Discord start while the upcoming read is pending
//  A2 list view: Discord starts while the past read is pending
//  A3 calendar view: past + Discord start together; the month-grid read
//     stays downstream of the first three
//  A4 guest cache: a concurrent first render settles the shared anon entry;
//     the next guest fetch serves it with no new DB or Discord reads
//  A5 error state: empty local reads + failed Discord read reads as "error",
//     never as an empty calendar (model and calendar-island fragment)
//  A6 empty states: "never" with no history, "gap" with only past rows
//     (model and calendar-island fragment)
//  A7 downstream order: persisted-id suppression still runs after the
//     Discord read resolves, so a synced transient never double-renders
//  A8 read order: count, upcoming rows and past rows issue before the
//     grouped going aggregate (the aggregate stays downstream of its rows)
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients-types";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";
import {
  EVENTS_CALENDAR_ISLAND,
  EVENTS_EMPTY_ERROR_TESTID,
  EVENTS_EMPTY_GAP_TESTID,
  EVENTS_EMPTY_NEVER_TESTID,
  type DiscordTransient,
} from "../src/islands/contracts";
import app from "./app";

const NOW = new Date("2060-06-01T00:00:00Z");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

function eventRow(
  id: number,
  over: Partial<typeof events.$inferSelect> = {},
): typeof events.$inferSelect {
  const startsAt = over.startsAt ?? new Date(NOW.getTime() + id * 3600_000);
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
    ...over,
  };
}

const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
function positional(row: typeof events.$inferSelect): unknown[] {
  return columns.map((key) => {
    const value = row[key];
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

interface FakeCalendar {
  db: Db;
  discord: DiscordEventsSource;
  state: {
    ascCalls: number;
    pastIssued: boolean;
    discordCalls: number;
    queries: string[];
  };
}

/**
 * pg-proxy fake for the calendar page model. The upcoming page orders
 * oldest-first (`"starts_at" asc`), the past drawer newest-first
 * (`"starts_at" desc`); the month-grid read is the second `asc` select.
 * Optional gates hold one read pending so a test can observe which other
 * reads started while it was still in flight.
 */
function fakeCalendar(opts: {
  upcoming?: (typeof events.$inferSelect)[];
  total?: number;
  past?: (typeof events.$inferSelect)[];
  month?: (typeof events.$inferSelect)[];
  discordRows?: DiscordTransient[];
  discordFailed?: boolean;
  persistedIds?: string[];
  gateUpcoming?: ReturnType<typeof deferred<{ rows: unknown[][] }>>;
  gatePast?: ReturnType<typeof deferred<{ rows: unknown[][] }>>;
}): FakeCalendar {
  const upcoming = opts.upcoming ?? [];
  const past = opts.past ?? [];
  const state = { ascCalls: 0, pastIssued: false, discordCalls: 0, queries: [] as string[] };
  const db = drizzle(async (sql: string) => {
    state.queries.push(sql);
    if (sql.startsWith("select count(*)"))
      return { rows: [[String(opts.total ?? upcoming.length)]] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id"')) {
      return { rows: (opts.persistedIds ?? []).map((id) => [id]) };
    }
    if (sql.includes('"starts_at" asc')) {
      state.ascCalls += 1;
      if (state.ascCalls === 1) {
        if (opts.gateUpcoming) return opts.gateUpcoming.promise;
        return { rows: upcoming.map(positional) };
      }
      return { rows: (opts.month ?? []).map(positional) };
    }
    if (sql.includes('"starts_at" desc')) {
      state.pastIssued = true;
      if (opts.gatePast) return opts.gatePast.promise;
      return { rows: past.map(positional) };
    }
    return { rows: [] };
  }) as unknown as Db;
  const discord: DiscordEventsSource = {
    upcoming: async () => {
      state.discordCalls += 1;
      return opts.discordRows ?? [];
    },
    lastReadFailed: () => opts.discordFailed ?? false,
  };
  return { db, discord, state };
}

function load(fake: FakeCalendar, input: Parameters<typeof resolveCalendarInput>[0] = {}) {
  return loadCalendarPageModel({
    db: fake.db,
    input: resolveCalendarInput(input),
    includeDrafts: false,
    discord: fake.discord,
    now: NOW,
  });
}

describe("calendar concurrent reads acceptance (model)", () => {
  it("A1: starts the past and Discord reads before a slow upcoming read resolves", async () => {
    const gate = deferred<{ rows: unknown[][] }>();
    const fake = fakeCalendar({ gateUpcoming: gate, total: 1 });
    const pending = load(fake);
    await tick();
    expect(fake.state.pastIssued).toBe(true);
    expect(fake.state.discordCalls).toBe(1);
    gate.resolve({ rows: [positional(eventRow(1))] });
    const model = await pending;
    expect(model.upcoming).toHaveLength(1);
    expect(model.past).toEqual([]);
    expect(model.totalPages).toBe(1);
    expect(model.discordFailed).toBe(false);
    expect(model.emptyState).toBeNull();
  });

  it("A2: starts the Discord read before a slow past read resolves", async () => {
    const gate = deferred<{ rows: unknown[][] }>();
    const fake = fakeCalendar({ upcoming: [eventRow(1)], gatePast: gate });
    const pending = load(fake);
    await tick();
    expect(fake.state.discordCalls).toBe(1);
    gate.resolve({ rows: [] });
    const model = await pending;
    expect(model.upcoming).toHaveLength(1);
    expect(model.past).toEqual([]);
  });

  it("A3: calendar view starts past + Discord together and keeps the month read downstream", async () => {
    const gate = deferred<{ rows: unknown[][] }>();
    const fake = fakeCalendar({ gateUpcoming: gate, total: 1 });
    const pending = load(fake, { view: "calendar", month: "2060-06" });
    await tick();
    expect(fake.state.pastIssued).toBe(true);
    expect(fake.state.discordCalls).toBe(1);
    // Only the upcoming page read has issued an `asc` select so far: the
    // month-grid read depends on the merged probe, so it stays downstream.
    expect(fake.state.ascCalls).toBe(1);
    gate.resolve({ rows: [positional(eventRow(1))] });
    const model = await pending;
    expect(model.state.view).toBe("calendar");
    expect(model.state.month).toBe("2060-06");
    expect(fake.state.ascCalls).toBe(2);
  });

  it("A5: an empty calendar with a failed Discord read is the error state, not an empty one", async () => {
    const model = await load(fakeCalendar({ discordFailed: true }));
    expect(model.discordFailed).toBe(true);
    expect(model.upcoming).toEqual([]);
    expect(model.past).toEqual([]);
    expect(model.emptyState).toBe("error");
  });

  it("A6: empty states distinguish never-scheduled from a gap with history", async () => {
    const never = await load(fakeCalendar({}));
    expect(never.emptyState).toBe("never");

    const pastRow = eventRow(9, {
      startsAt: new Date("2060-05-01T18:00:00Z"),
      endsAt: new Date("2060-05-01T20:00:00Z"),
    });
    const gap = await load(fakeCalendar({ past: [pastRow] }));
    expect(gap.emptyState).toBe("gap");
    expect(gap.past).toHaveLength(1);
    expect(gap.past[0]?.eventKey).toBe("event-9");
  });

  it("A7: a Discord transient already persisted locally is suppressed after the parallel reads", async () => {
    const transient: DiscordTransient = {
      discordId: "d-synced",
      status: "scheduled",
      title: "Synced raid",
      description: null,
      location: null,
      startsAt: new Date(NOW.getTime() + 3600_000),
      endsAt: new Date(NOW.getTime() + 7200_000),
    };
    const model = await load(
      fakeCalendar({
        upcoming: [eventRow(1)],
        discordRows: [transient],
        persistedIds: ["d-synced"],
      }),
    );
    expect(model.upcoming).toHaveLength(1);
    expect(model.upcoming[0]).not.toHaveProperty("discordId");
  });
});

/* ------------------------------------------------------------ route level */

const APP_URL = "https://next.example.test";
const ROUTE_NOW = Date.now();

function routeEventRow(
  id: number,
  over: Partial<typeof events.$inferSelect> = {},
): typeof events.$inferSelect {
  const startsAt = over.startsAt ?? new Date(ROUTE_NOW + (10 + id) * 86400_000);
  return eventRow(id, { createdAt: new Date(), updatedAt: new Date(), ...over, startsAt });
}

/**
 * Mounted-app fake through the real /events route (same seam as the guest
 * calendar suite): upcoming vs past split by the `ends_at` boundary operator,
 * Discord through the DISCORD_EVENTS env seam.
 */
function routeCalendar(opts: {
  upcoming?: (typeof events.$inferSelect)[];
  past?: (typeof events.$inferSelect)[];
  discordFailed?: boolean;
  gateUpcoming?: ReturnType<typeof deferred<{ rows: unknown[][] }>>;
}) {
  const up = opts.upcoming ?? [];
  const past = opts.past ?? [];
  const state = { pastIssued: false, discordCalls: 0, queries: [] as string[] };
  const db = drizzle(async (sql: string, params: unknown[]) => {
    state.queries.push(sql);
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
    if (sql.includes('"starts_at" desc')) state.pastIssued = true;
    if (opts.gateUpcoming && sql.includes('"starts_at" asc') && !sql.startsWith("select count")) {
      return opts.gateUpcoming.promise;
    }
    let rows = /"ends_at" </.test(sql) ? past : up;
    if (sql.includes("'draft'")) rows = rows.filter((r) => r.status !== "draft");
    if (/^select count/i.test(sql)) return { rows: [[opts.gateUpcoming ? 1 : rows.length]] };
    if (sql.includes("limit")) rows = rows.slice(0, Number(params.at(-1)));
    return { rows: rows.map(positional) };
  });
  const discord: DiscordEventsSource = {
    upcoming: async () => {
      state.discordCalls += 1;
      return [];
    },
    lastReadFailed: () => opts.discordFailed ?? false,
  };
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: discord,
  } as unknown as Env;
  return {
    state,
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
}

describe("calendar concurrent reads acceptance (/events route)", () => {
  beforeEach(() => {
    __resetAnonEventCacheForTests();
  });

  it("A4: a concurrent guest render settles the anon cache; the next guest fetch re-reads nothing", async () => {
    const gate = deferred<{ rows: unknown[][] }>();
    const src = routeCalendar({ gateUpcoming: gate });
    const inflight = src.request("/events");
    await tick(50);
    // While the upcoming read is pending, the past and Discord reads have
    // already started — sequential dispatch would hold both behind it.
    expect(src.state.pastIssued).toBe(true);
    expect(src.state.discordCalls).toBe(1);
    gate.resolve({ rows: [positional(routeEventRow(1))] });
    const first = await inflight;
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await first.text()).toContain("Game night 1");

    const queriesAfterFirst = src.state.queries.length;
    const second = await src.request("/events");
    expect(second.status).toBe(200);
    expect(second.headers.get("cache-control")).toMatch(/^public, max-age=(59|60)$/);
    expect(await second.text()).toContain("Game night 1");
    // Shared-cache hit: no new DB queries and no new Discord read.
    expect(src.state.queries.length).toBe(queriesAfterFirst);
    expect(src.state.discordCalls).toBe(1);
  });

  it("A8: the past read issues before the upcoming going aggregate", async () => {
    const src = routeCalendar({ upcoming: [routeEventRow(1)] });
    const res = await src.request("/events");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Game night 1");
    // New dispatch order: upcoming count, upcoming rows, past rows, then the
    // grouped going aggregate for the upcoming page (never per-card queries).
    const kinds = src.state.queries.map((sql) => (sql.includes("rsvps") ? "rsvps" : "events"));
    expect(kinds).toEqual(["events", "events", "events", "rsvps"]);
    expect(src.state.queries[0]).toMatch(/^select count/i);
    expect(src.state.queries[3]).toContain('group by "rsvps"."event_id"');
  });

  it("A5: the calendar island fragment renders the error state on a failed Discord read", async () => {
    const src = routeCalendar({ discordFailed: true });
    const res = await src.request("/events", {
      headers: { "x-two-island": EVENTS_CALENDAR_ISLAND },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`data-testid="${EVENTS_EMPTY_ERROR_TESTID}"`);
    expect(html).not.toContain(`data-testid="${EVENTS_EMPTY_NEVER_TESTID}"`);
  });

  it("A6: the calendar island fragment renders never / gap empty states", async () => {
    const never = await (
      await routeCalendar({}).request("/events", {
        headers: { "x-two-island": EVENTS_CALENDAR_ISLAND },
      })
    ).text();
    expect(never).toContain(`data-testid="${EVENTS_EMPTY_NEVER_TESTID}"`);

    const pastRow = routeEventRow(9, {
      startsAt: new Date("2020-03-04T18:00:00Z"),
      endsAt: new Date("2020-03-04T20:00:00Z"),
    });
    const gap = await (
      await routeCalendar({ past: [pastRow] }).request("/events", {
        headers: { "x-two-island": EVENTS_CALENDAR_ISLAND },
      })
    ).text();
    expect(gap).toContain(`data-testid="${EVENTS_EMPTY_GAP_TESTID}"`);
    expect(gap).toContain("Game night 9");
  });
});
