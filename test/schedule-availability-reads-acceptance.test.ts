// route-inventory: GET /events
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { dispatchEventsRequest, loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import app from "./app";
import { NOW, ORIGIN, TWO_LEFT, event } from "./fixtures/schedule-availability";

function transport(rowCount: number) {
  const rows = Array.from({ length: rowCount }, (_, i) =>
    event({
      id: i + 1,
      eventKey: `01K7MZ${String(i + 1).padStart(20, "0")}`,
      rsvpOpen: i % 2 === 0,
    }),
  );
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params: [...params] });
    if (sql.includes('from "rsvps"')) {
      // Distinct named/occupied aggregates; render must not fall back to named count.
      // The combined shape carries both sides: (event_id, named 3, occupied 8).
      if (sql.includes('left join "users"') && sql.includes("group by"))
        return { rows: rows.map((row) => [row.id, 3, 8]) };
      const n = sql.includes('join "users"') ? 3 : 8;
      return { rows: rows.map((row) => [row.id, n]) };
    }
    if (/select\s+distinct/i.test(sql)) return { rows: [["Deep Rock Galactic"]] };
    if (sql.includes('from "events"')) {
      if (/"ends_at" </.test(sql)) return { rows: [] };
      if (/^select count/i.test(sql)) return { rows: [[rows.length]] };
      return {
        rows: rows.map((row) =>
          columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
        ),
      };
    }
    throw new Error(`Unexpected read or mutation: ${sql}`);
  }) as unknown as Db;
  const source = { upcoming: vi.fn(async () => []), lastReadFailed: () => false };
  const env = {
    APP_URL: ORIGIN,
    DISCORD_CLIENT_ID: "fixture-client",
    DISCORD_GUILD_ID: "123456789012345678",
    DISCORD_INVITE_URL: "https://discord.gg/example",
    ADMIN_DB: db,
    DISCORD_EVENTS: source,
  } as unknown as Env;
  const session = vi.fn(async () => null);
  const journey = vi.fn(async () => null);
  async function request(target: "Hono" | "Kit", path: string, island = false) {
    const req = new Request(new URL(path, ORIGIN), {
      headers: island ? { "x-two-island": "events-calendar" } : {},
    });
    if (target === "Hono") return app.request(req, undefined, env);
    return dispatchEventsRequest(
      req,
      env,
      async () => {
        const headers: Record<string, string> = {};
        const data = await loadEventsPage({
          env,
          url: new URL(req.url),
          method: "GET",
          island,
          request: req,
          setHeaders: (h) => Object.assign(headers, h),
          deleteJoinCookie: () => {
            throw new Error("no guest cookie to consume");
          },
          dbForFn: async () => db,
          sessionForFn: session,
          journeyForFn: journey,
          discordForFn: () => source,
          now: NOW,
        });
        const rendered = await renderEventsHtml(data, headers);
        return new Response(rendered.body, { status: rendered.status, headers: rendered.headers });
      },
      { guard: async () => null, sessionFor: session, journeyFor: journey, now: NOW.getTime() },
    );
  }
  return { queries, source, session, request };
}

beforeEach(() => __resetAnonEventCacheForTests());

for (const target of ["Hono", "Kit"] as const) {
  describe(`${target} existing read/cache limits`, () => {
    for (const rowCount of [1, 12]) {
      for (const calendar of [false, true]) {
        it(`CONTROL: ${rowCount} rows in ${calendar ? "month" : "list"} use batched aggregates, never per-card reads`, async () => {
          const fixture = transport(rowCount);
          const path = calendar ? "/events?view=calendar&month=2035-10" : "/events";
          const response = await fixture.request(target, path);
          expect(response.status).toBe(200);
          const html = await response.text();
          expect(html).toContain("Cooperative expedition");
          expect(fixture.queries.filter((q) => q.sql.includes('from "rsvps"'))).toHaveLength(
            calendar ? 2 : 1,
          );
          expect(fixture.queries.filter((q) => /select\s+distinct/i.test(q.sql))).toHaveLength(1);
          expect(fixture.queries, fixture.queries.map((q) => q.sql).join("\n")).toHaveLength(
            calendar ? 7 : 5,
          );
          const games = fixture.queries.find((q) => /select\s+distinct/i.test(q.sql))!;
          expect(games.params.at(-1)).toBe(100);
          const pages = fixture.queries.filter(
            (q) =>
              q.sql.includes('from "events"') && !/select\s+distinct|^select count/i.test(q.sql),
          );
          expect(pages.map((q) => q.params.at(-1)).sort((a, b) => Number(a) - Number(b))).toEqual(
            calendar ? [20, 21, 200] : [20, 21],
          );
          expect(fixture.source.upcoming).toHaveBeenCalledTimes(1);
          if (target === "Kit") expect(fixture.session).toHaveBeenCalledTimes(2);
          expect(fixture.queries.every((q) => /^select\b/i.test(q.sql))).toBe(true);
        });
      }
    }

    it("CONTROL: a repeated anonymous HTML request uses its existing cache, not new availability reads", async () => {
      const fixture = transport(12);
      const first = await fixture.request(target, "/events");
      expect(first.status).toBe(200);
      const original = await first.text();
      expect(fixture.queries).toHaveLength(5);
      const second = await fixture.request(target, "/events");
      expect(await second.text()).toBe(original);
      expect(second.headers.get("cache-control")).toMatch(/public.*max-age=/);
      expect(fixture.queries).toHaveLength(5);
      expect(fixture.source.upcoming).toHaveBeenCalledTimes(1);
    });

    it("route/loader projection carries occupancy-derived availability into the real renderer", async () => {
      const fixture = transport(1);
      const response = await fixture.request(target, "/events", true);
      expect(response.status).toBe(200);
      const html = await response.text();
      const card = html.match(/<article\b[\s\S]*?<\/article>/)?.[0];
      expect(card).toBeDefined();
      expect(card!.replace(/<[^>]*>/g, " ")).toMatch(TWO_LEFT);
    });
  });
}
