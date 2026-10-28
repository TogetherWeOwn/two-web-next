// route-inventory: GET /events
// Hermetic pg-proxy transport, real reads/loader/rendering. No database needed.
// Run: env -u DATABASE_URL npx vitest run test/schedule-ongoing-reads-acceptance.test.ts
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { dispatchEventsRequest, loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";
import app from "./app";
import { KEY, ORIGIN, TWO_LEFT } from "./fixtures/schedule-availability";
import {
  MID,
  ONGOING,
  at,
  ongoingEvent,
  scheduleEntries,
  visibleText,
} from "./helpers/event-ongoing-acceptance";

function transport(count: number) {
  const rows = Array.from({ length: count }, (_, index) =>
    ongoingEvent({
      id: index + 1,
      eventKey: index === 0 ? KEY : `01K7MZ${String(index + 1).padStart(20, "0")}`,
    }),
  );
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const queries: string[] = [];
  const db = drizzle(async (sql) => {
    queries.push(sql);
    if (!/^select\b/i.test(sql)) throw new Error(`Unexpected write: ${sql}`);
    if (sql.includes('from "rsvps"'))
      return { rows: rows.map((row) => [row.id, sql.includes('join "users"') ? 3 : 8]) };
    if (/select\s+distinct/i.test(sql)) return { rows: [["Deep Rock Galactic"]] };
    if (sql.includes('from "events"')) {
      if (/"ends_at" </.test(sql)) return { rows: [] };
      if (/^select count/i.test(sql)) return { rows: [[count]] };
      return {
        rows: rows.map((row) =>
          columns.map((key) => (row[key] instanceof Date ? row[key].toISOString() : row[key])),
        ),
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }) as unknown as Db;
  const source = { upcoming: vi.fn(async () => []), lastReadFailed: () => false };
  const env = {
    APP_URL: ORIGIN,
    ADMIN_DB: db,
    DISCORD_EVENTS: source,
    DISCORD_CLIENT_ID: "fixture-client",
    DISCORD_GUILD_ID: "123456789012345678",
    DISCORD_INVITE_URL: "https://discord.gg/example",
  } as unknown as Env;
  const session = async () => null;
  const journey = async () => null;
  async function request(twin: "Hono" | "Kit", path: string, fragment: boolean) {
    return at(MID, async () => {
      const req = new Request(new URL(path, ORIGIN), {
        headers: fragment ? { "x-two-island": "events-calendar" } : {},
      });
      if (twin === "Hono") return app.request(req, undefined, env);
      return dispatchEventsRequest(
        req,
        env,
        async () => {
          const headers: Record<string, string> = {};
          const data = await loadEventsPage({
            env,
            url: new URL(req.url),
            method: "GET",
            island: fragment,
            request: req,
            setHeaders: (value) => Object.assign(headers, value),
            deleteJoinCookie: () => {
              throw new Error("No fixture cookie to consume");
            },
            dbForFn: async () => db,
            sessionForFn: session,
            journeyForFn: journey,
            discordForFn: () => source,
            now: MID,
          });
          const rendered = await renderEventsHtml(data, headers);
          return new Response(rendered.body, {
            status: rendered.status,
            headers: rendered.headers,
          });
        },
        { guard: async () => null, sessionFor: session, journeyFor: journey, now: MID.getTime() },
      );
    });
  }
  return { queries, source, request };
}

beforeEach(() => __resetAnonEventCacheForTests());
afterEach(() => vi.restoreAllMocks());

// Breaks caught: new per-row/clock SQL, missing loader projection, or a label
// added only on full page loads rather than existing calendar fragment SSR.
for (const twin of ["Hono", "Kit"] as const) {
  for (const view of ["list", "calendar"] as const) {
    describe(`${twin} ${view} ongoing read bounds`, () => {
      for (const count of [1, 12]) {
        for (const fragment of [false, true]) {
          it(`${count} rows, ${fragment ? "fragment" : "document"}: ongoing SSR uses existing query count`, async () => {
            const fixture = transport(count);
            const path = view === "calendar" ? "/events?view=calendar&month=2035-10" : "/events";
            const response = await fixture.request(twin, path, fragment);
            expect(response.status).toBe(200);
            const html = await response.text();
            expect(fixture.queries).toHaveLength(view === "calendar" ? 9 : 6);
            expect(fixture.queries.filter((sql) => sql.includes('from "rsvps"'))).toHaveLength(
              view === "calendar" ? 4 : 2,
            );
            expect(fixture.source.upcoming).toHaveBeenCalledTimes(1);
            for (const row of scheduleEntries(html, KEY, view)) {
              expect.soft(visibleText(row)).toMatch(ONGOING);
              expect.soft(visibleText(row)).toMatch(TWO_LEFT);
            }
          });
        }
      }
    });
  }

  it(`${twin} CONTROL: anonymous cache and its public policy are unchanged`, async () => {
    const fixture = transport(12);
    const first = await fixture.request(twin, "/events", false);
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(fixture.queries).toHaveLength(6);
    const cached = await fixture.request(twin, "/events", false);
    expect(cached.status).toBe(200);
    expect(await cached.text()).toBe(html);
    expect(cached.headers.get("cache-control")).toBe("public, max-age=60");
    expect(fixture.queries).toHaveLength(6);
    expect(fixture.source.upcoming).toHaveBeenCalledTimes(1);
  });
}
