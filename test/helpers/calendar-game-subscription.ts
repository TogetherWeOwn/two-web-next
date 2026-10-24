import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { __resetAnonEventCacheForTests } from "../../src/events/anon-cache";
import { loadEventsPage } from "../../src/kit-events";
import { renderEventsHtml } from "../../src/kit-events-html";
import app from "../app";
import { calendarRow, OTHER_KEY } from "./ics-wire-fixture";

export const GAME_CALENDAR_ORIGIN = "https://calendar.example.test";
export const HOSTILE_GAME = '東京 🎮;raid,back\\slash & <tag>" /?#=+%';
export type CalendarRenderer = "hono" | "kit";

// Both real page loaders/renderers consume one local SQL transport. Never
// replace the controls or island with test-generated markup or handlers.
export function gameSubscriptionFixture(renderer: CalendarRenderer) {
  const rows = ["Factorio", "Helldivers 2", HOSTILE_GAME].map((game, i) =>
    calendarRow({
      id: i + 1,
      game,
      eventKey: i === 0 ? OTHER_KEY : `fixture-game-${i}`,
      title: `Raid ${game}`,
      startsAt: new Date("2035-01-15T18:00:00Z"),
      endsAt: new Date("2035-01-15T20:00:00Z"),
    }),
  );
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql, params) => {
    if (/^select distinct trim\("game"\)/i.test(sql))
      return { rows: rows.map((row) => [row.game]) };
    if (sql.includes('from "rsvps"') || sql.startsWith('select "discord_event_id"'))
      return { rows: [] };
    if (!sql.includes('from "events"'))
      throw new Error(`Unexpected subscription fixture SQL: ${sql}`);
    let matching = /"ends_at" </.test(sql) ? [] : rows;
    const where = sql.split(/\bwhere\b/i)[1] ?? "";
    const game = /lower\(trim\("events"\."game"\)\)\s*=\s*\$(\d+)/i.exec(where);
    if (game)
      matching = matching.filter(
        (row) => row.game!.trim().toLowerCase() === params[Number(game[1]) - 1],
      );
    const term = params.find(
      (p): p is string => typeof p === "string" && p.startsWith("%") && p.endsWith("%"),
    );
    if (term)
      matching = matching.filter((row) =>
        row.title.toLowerCase().includes(term.slice(1, -1).toLowerCase()),
      );
    if (/^select count/i.test(sql)) return { rows: [[matching.length]] };
    return {
      rows: matching.map((row) =>
        columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
      ),
    };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<unknown>) =>
      fn({
        execute: async () => ({ rows: [] }),
        insert: () => ({ values: async () => undefined }),
      } as unknown as Db),
  });
  const discord = { upcoming: async () => [], lastReadFailed: () => false };
  const env = {
    APP_URL: GAME_CALENDAR_ORIGIN,
    ADMIN_DB: db as unknown as Db,
    DISCORD_EVENTS: discord,
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
  } as unknown as Env;
  return {
    async request(path: string, fragment = false) {
      __resetAnonEventCacheForTests();
      const url = new URL(path, GAME_CALENDAR_ORIGIN);
      const headers: Record<string, string> = fragment ? { "x-two-island": "events-calendar" } : {};
      if (renderer === "hono") return app.request(url.href, { headers }, env);
      const collected: Record<string, string> = {};
      const data = await loadEventsPage({
        env,
        url,
        method: "GET",
        island: fragment,
        request: new Request(url, { headers }),
        setHeaders: (next) => Object.assign(collected, next),
        deleteJoinCookie: () => {},
        dbForFn: async () => db as unknown as Db,
        sessionForFn: async () => null,
        journeyForFn: async () => null,
        discordForFn: () => discord,
      });
      const rendered = await renderEventsHtml(data as never, collected);
      return new Response(rendered.body, { status: rendered.status, headers: rendered.headers });
    },
  };
}
