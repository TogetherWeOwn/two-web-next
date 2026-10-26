// Independent schedule-return fixtures. Only SQL transport and audit persistence
// are substituted; calendar models, detail loads and both renderers stay real.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import type { DiscordTransient } from "../../src/islands/contracts";
import { registerEventRoutes } from "../../src/events/routes";
import { loadEventsPage } from "../../src/kit-events";
import { renderEventsHtml } from "../../src/kit-events-html";
import {
  ARCHIVE_ORIGIN,
  compileReturnTwins,
  eventKey,
  returnFixture,
} from "./archive-detail-return-acceptance";
import { archiveRow, type ArchiveTwin } from "./past-archive-search-acceptance";

export const SCHEDULE_ORIGIN = ARCHIVE_ORIGIN;
export const SCHEDULE_QUERY = 'Crew 🌌 "night" & <table>';
export const SCHEDULE_NOW = new Date("2030-06-15T12:00:00Z");
export const SELECTED_KEY = eventKey(21);
export const SELECTED_PATH = `/e/${SELECTED_KEY}`;
export const PAST_KEY = eventKey(41);
export const LIST_PATH = `/events?${new URLSearchParams({ q: SCHEDULE_QUERY, game: "Chess", page: "2", past: "1" })}`;
export const GRID_PATH = "/events?game=Chess&past=1&view=calendar&month=2031-01";
export const SCHEDULE_TWINS: ArchiveTwin[] = ["Hono", "Kit"];

export function scheduleRow(id: number, overrides: Parameters<typeof archiveRow>[1] = {}) {
  const day = String(id <= 25 ? id : 10).padStart(2, "0");
  return archiveRow(id, {
    eventKey: eventKey(id),
    title: `${SCHEDULE_QUERY} ${id}`,
    game: "Chess",
    status: "published",
    startsAt: new Date(`2031-01-${day}T20:00:00Z`),
    endsAt: new Date(`2031-01-${day}T22:00:00Z`),
    goingCount: 205,
    goingOccupancy: 205,
    ...overrides,
  });
}

export function scheduleFixture() {
  const upcoming = [
    ...Array.from({ length: 25 }, (_, i) => scheduleRow(i + 1)),
    scheduleRow(31, { game: "Go" }),
    scheduleRow(32, { title: "Unrelated chess clinic" }),
    scheduleRow(33, { status: "cancelled", title: "Cancelled chess night" }),
  ];
  const past = [
    scheduleRow(41, {
      status: "past",
      startsAt: new Date("2029-01-10T20:00:00Z"),
      endsAt: new Date("2029-01-10T22:00:00Z"),
    }),
  ];
  const transient: DiscordTransient = {
    discordId: "700000000000000001",
    status: "scheduled",
    title: "Discord-only chess night",
    description: null,
    location: null,
    startsAt: new Date("2031-01-11T20:00:00Z"),
    endsAt: null,
  };
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encode = (row: ReturnType<typeof scheduleRow>) =>
    columns.map((key) => {
      const value = row[key];
      return value instanceof Date ? value.toISOString() : value;
    });
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params: [...params] });
    if (sql.includes('from "rsvps"')) return { rows: [[21, 205]] };
    if (/^select\s+distinct/i.test(sql)) return { rows: [["Chess"], ["Go"]] };
    if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
    if (!sql.includes('from "events"')) throw new Error("Unexpected schedule fixture SQL");
    let rows = /"ends_at" </.test(sql) ? past : upcoming;
    const game = params.find((p) => typeof p === "string" && /^(chess|go)$/i.test(p.trim()));
    if (typeof game === "string")
      rows = rows.filter((r) => r.game?.toLowerCase() === game.trim().toLowerCase());
    const query = params.find((p) => typeof p === "string" && p.startsWith("%") && p.endsWith("%"));
    if (typeof query === "string") {
      const term = query.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      rows = rows.filter((r) => `${r.title} ${r.description ?? ""}`.toLowerCase().includes(term));
    }
    if (sql.includes('"event_key" =') && !/^select count/i.test(sql)) {
      rows = rows.filter((r) => params.includes(r.eventKey));
    }
    // Rank's count includes a scalar subselect of the selected row's timestamp.
    if (/^select count/i.test(sql) && sql.includes('(select "starts_at"')) {
      const anchor = upcoming.find((r) => r.id === params.at(-1));
      return {
        rows: [
          [
            anchor
              ? rows.filter(
                  (r) =>
                    r.startsAt < anchor.startsAt ||
                    (r.startsAt.getTime() === anchor.startsAt.getTime() && r.id < anchor.id),
                ).length
              : 0,
          ],
        ],
      };
    }
    if (/^select count/i.test(sql)) return { rows: [[rows.length]] };
    if (Number(params.at(-1)) === 200) {
      const from = new Date(String(params.at(-2)));
      const to = new Date(String(params.at(-3)));
      rows = rows.filter((r) => r.startsAt < to && r.endsAt > from);
    }
    rows = [...rows].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
    if (sql.includes("limit")) {
      const offset = sql.includes(" offset ") ? Number(params.at(-1)) : 0;
      const limit = Number(params.at(sql.includes(" offset ") ? -2 : -1));
      rows = rows.slice(offset, offset + limit);
    }
    return { rows: rows.map(encode) };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) =>
      fn({ execute: async () => [] } as unknown as Db),
  });
  const source = { upcoming: async () => [transient], lastReadFailed: () => false };
  const env = {
    APP_URL: SCHEDULE_ORIGIN,
    ADMIN_DB: db,
    DISCORD_INVITE_URL: "https://discord.gg/example",
    DISCORD_EVENTS: source,
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(
    app,
    async () => null,
    async () => null,
  );
  return {
    queries,
    async render(twin: ArchiveTwin, path: string, island = false) {
      const url = new URL(path, SCHEDULE_ORIGIN);
      const headers: Record<string, string> = island ? { "x-two-island": "events-calendar" } : {};
      if (twin === "Hono") return app.request(url.href, { headers }, env);
      const collected: Record<string, string> = {};
      const data = await loadEventsPage({
        env,
        url,
        method: "GET",
        island,
        request: new Request(url, { headers }),
        setHeaders: (values) => Object.assign(collected, values),
        deleteJoinCookie() {},
        dbForFn: async () => db as unknown as Db,
        sessionForFn: async () => null,
        journeyForFn: async () => null,
        discordForFn: () => source,
      });
      const result = await renderEventsHtml(data as never, collected);
      return new Response(result.body, { status: result.status, headers: result.headers });
    },
  };
}

export function scheduleDetailFixture() {
  const fixture = returnFixture();
  fixture.setEvent(scheduleRow(21));
  return fixture;
}
export { compileReturnTwins };
