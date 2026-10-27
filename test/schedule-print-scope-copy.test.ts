// Builder-owned pins for the list scope stamp's zero-page copy: with no
// upcoming pages the stamp must name what renders (past events, unpaged
// upcoming cards) instead of reading "nothing listed" over event cards.
// The paired acceptance file owns SP-__ case IDs; this file owns the copy
// matrix and the transient/gap wiring it added.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import type { Db } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients-types";
import type { DiscordTransient } from "../src/islands/contracts";
import { printScopeCopy } from "../src/islands/contracts-print-scope";

const APP_URL = "https://scope-copy.example.test";
const baseEnv = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/example",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
} as unknown as Env;

let eventSeq = 0;
type EventRow = typeof events.$inferSelect;
function eventRow(over: Partial<EventRow> = {}): EventRow {
  const n = ++eventSeq;
  const start = over.startsAt ?? new Date(Date.UTC(2099, 6, 15, 20));
  const end = over.endsAt ?? new Date(start.getTime() + 7200_000);
  return {
    id: n,
    icsSequence: 1n,
    eventKey: `01C${String(n).padStart(23, "0")}`,
    title: `Game night ${n}`,
    game: null,
    description: null,
    startsAt: start,
    endsAt: end,
    timezone: "UTC",
    location: null,
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
    recurrenceIndex: null,
    parentEventId: null,
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}
function pastRow(over: Partial<EventRow> = {}): EventRow {
  const start = over.startsAt ?? new Date(Date.UTC(2020, 6, 15, 20));
  return eventRow({
    ...over,
    startsAt: start,
    endsAt: over.endsAt ?? new Date(start.getTime() + 7200_000),
  });
}
function transientRow(over: Partial<DiscordTransient> = {}): DiscordTransient {
  return {
    discordId: "1545644954272137999",
    status: "scheduled",
    title: "Discord native night",
    description: null,
    location: null,
    startsAt: new Date("2030-07-15T21:00:00Z"),
    endsAt: new Date("2030-07-15T23:00:00Z"),
    ...over,
  };
}

function scopeFixture(args: {
  upcoming?: EventRow[];
  past?: EventRow[];
  source?: DiscordEventsSource;
}) {
  const upcoming = args.upcoming ?? [];
  const past = args.past ?? [];
  const source = args.source ?? { upcoming: async () => [], lastReadFailed: () => false };
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const encode = (row: EventRow) =>
    columns.map((k) => {
      const v = row[k];
      return v instanceof Date ? v.toISOString() : v;
    });
  const applyFilters = (rows: EventRow[], sql: string, params: unknown[]): EventRow[] => {
    let out = rows;
    const qBound = params.find(
      (p): p is string => typeof p === "string" && p.startsWith("%") && p.endsWith("%"),
    );
    if (qBound) {
      const term = qBound.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      out = out.filter(
        (r) =>
          r.title.toLowerCase().includes(term) ||
          (r.description ?? "").toLowerCase().includes(term),
      );
    }
    return out;
  };
  const page = (rows: EventRow[], sql: string, params: unknown[]): EventRow[] => {
    if (!sql.includes("limit")) return rows;
    const hasOffset = sql.includes(" offset ");
    const offset = hasOffset ? Number(params.at(-1)) : 0;
    const limit = Number(params.at(hasOffset ? -2 : -1));
    const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const end = Number.isSafeInteger(limit) ? start + limit : rows.length;
    return rows.slice(start, end);
  };
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id" from "events"')) return { rows: [] };
    if (/select\s+distinct/i.test(sql) && /game/i.test(sql)) return { rows: [] };
    const isArchive =
      params.includes("past") || /order by "starts_at" desc/i.test(sql) || /"ends_at" </.test(sql);
    const rows = applyFilters(isArchive ? past : upcoming, sql, params);
    if (/^select count/i.test(sql)) return { rows: [[rows.length]] };
    return { rows: page(rows, sql, params).map(encode) };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) =>
      fn({ execute: async () => {} } as unknown as Db),
  });
  const adminDb = db as unknown as Db;
  const env = { ...baseEnv, ADMIN_DB: adminDb, DISCORD_EVENTS: source } as unknown as Env;
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
}

const stampOf = (html: string): string | null =>
  new RegExp(`<p\\b[^>]*data-testid="events-print-scope"[^>]*>([\\s\\S]*?)</p>`)
    .exec(html)?.[1]
    ?.replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim() ?? null;
const cardCount = (html: string): number => (html.match(/data-testid="event-card"/g) ?? []).length;

beforeEach(() => __resetAnonEventCacheForTests());

describe("printScopeCopy zero-page matrix", () => {
  it("names pages when they exist", () => {
    expect(printScopeCopy("Upcoming events", "Paged", "Chess", 2, 5)).toBe(
      "Upcoming events · search “Paged” · game Chess · page 2 of 5. Only the events on this page are listed.",
    );
  });
  it("names past matches under a search or game filter", () => {
    expect(printScopeCopy("Upcoming events", "chess", null, 1, 0, "past")).toBe(
      "Upcoming events · search “chess” · past matches only. Only the events on this page are listed.",
    );
    expect(printScopeCopy("Upcoming events", "", "Chess", 1, 0, "past")).toBe(
      "Upcoming events · game Chess · past matches only. Only the events on this page are listed.",
    );
  });
  it("names past events in the unfiltered gap", () => {
    expect(printScopeCopy("Upcoming events", "", null, 1, 0, "past")).toBe(
      "Upcoming events · past events only. Only the events on this page are listed.",
    );
  });
  it("names page one for unpaged upcoming cards", () => {
    expect(printScopeCopy("Upcoming events", "", null, 1, 0, "page1")).toBe(
      "Upcoming events · page 1. Only the events on this page are listed.",
    );
  });
  it("defaults to nothing listed", () => {
    expect(printScopeCopy("Upcoming events", "", null, 1, 0)).toBe(
      "Upcoming events · nothing listed. Only the events on this page are listed.",
    );
    expect(printScopeCopy("Past events archive", "", null, 1, 0)).toBe(
      "Past events archive · nothing listed. Only the events on this page are listed.",
    );
  });
});

describe("list stamp zero-page wiring", () => {
  it("gap state stamps past events over the gap list", async () => {
    const src = scopeFixture({ upcoming: [], past: [pastRow({ title: "Old chess final" })] });
    const res = await src.request("/events");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="events-empty-gap"');
    expect(stampOf(html)).toBe(
      "Upcoming events · past events only. Only the events on this page are listed.",
    );
  });
  it("transient-only stamps page one over rendered cards", async () => {
    const src = scopeFixture({
      upcoming: [],
      past: [],
      source: { upcoming: async () => [transientRow()], lastReadFailed: () => false },
    });
    const res = await src.request("/events");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(cardCount(html)).toBeGreaterThan(0);
    const stamp = stampOf(html);
    expect(stamp).not.toBeNull();
    expect(stamp!).toContain("page 1");
    expect(stamp!).not.toContain("of");
    expect(stamp!).not.toContain("nothing listed");
  });
  it("search miss still stamps nothing listed", async () => {
    const src = scopeFixture({ upcoming: [], past: [] });
    const res = await src.request("/events?q=zzzznomatch");
    expect(res.status).toBe(200);
    const stamp = stampOf(await res.text());
    expect(stamp).not.toBeNull();
    expect(stamp!).toContain("nothing listed");
  });
});
