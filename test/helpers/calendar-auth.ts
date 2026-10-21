import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Db } from "../../src/db/index";
import { events } from "../../src/db/admin-schema";
import type { Env } from "../../src/env";
import app from "../app";
import { loadEventsPage } from "../../src/kit-events";
import { renderEventsHtml } from "../../src/kit-events-html";

export const CALENDAR_AUTH_ORIGIN = "https://calendar.example.test";
export const CALENDAR_AUTH_QUERY = 'Raid & friends 雪 🦊 /?#=+% "night"';

// The real mounted Hono route and shared renderers read only these local rows.
// No database, credentials, OAuth request or Discord source is involved.
export function calendarAuthFixture(renderer: "hono" | "kit" = "hono") {
  const rows = Array.from({ length: 26 }, (_, i): typeof events.$inferSelect => ({
    id: i + 1,
    icsSequence: 1n,
    eventKey: `auth-calendar-${i + 1}`,
    title: i === 25 ? CALENDAR_AUTH_QUERY : `Community game night ${i + 1}`,
    game: null,
    description: "Local calendar acceptance fixture",
    startsAt: new Date("2030-01-12T20:00:00Z"),
    endsAt: new Date("2030-01-12T22:00:00Z"),
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
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: new Date("2030-01-01T00:00:00Z"),
    updatedAt: new Date("2030-01-01T00:00:00Z"),
  }));
  const past = {
    ...rows[0]!,
    id: 100,
    eventKey: "auth-calendar-past",
    startsAt: new Date("2020-01-12T20:00:00Z"),
    endsAt: new Date("2020-01-12T22:00:00Z"),
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encode = (row: typeof events.$inferSelect) =>
    columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key]));
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id"')) return { rows: [] };
    if (sql.startsWith('insert into "event_search_log"') || sql.startsWith("SET LOCAL"))
      return { rows: [] };
    if (!sql.includes('from "events"')) throw new Error(`Unexpected calendar query: ${sql}`);
    let matching = /"ends_at" </.test(sql) ? [past] : rows;
    const term = params.find(
      (p): p is string => typeof p === "string" && p.startsWith("%") && p.endsWith("%"),
    );
    if (term) {
      const query = term.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      matching = matching.filter((row) => row.title.toLowerCase().includes(query));
    }
    if (/^select count/i.test(sql)) return { rows: [[matching.length]] };
    if (sql.includes("offset")) {
      const offset = Number(params.at(-1));
      matching = matching.slice(offset, offset + Number(params.at(-2)));
    } else if (sql.includes("limit")) matching = matching.slice(0, Number(params.at(-1)));
    return { rows: matching.map(encode) };
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
    APP_URL: CALENDAR_AUTH_ORIGIN,
    DISCORD_INVITE_URL: "https://discord.gg/fixture",
    DISCORD_EVENTS: discord,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    env,
    request: async (path: string, fragment = false) => {
      const url = new URL(path, CALENDAR_AUTH_ORIGIN);
      const headers: Record<string, string> = fragment ? { "x-two-island": "events-calendar" } : {};
      if (renderer === "hono") return app.request(url.href, { headers }, env);
      const collected: Record<string, string> = {};
      const data = await loadEventsPage({
        env,
        url,
        method: "GET",
        island: fragment,
        request: new Request(url, { headers }),
        setHeaders: (headers) => Object.assign(collected, headers),
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
