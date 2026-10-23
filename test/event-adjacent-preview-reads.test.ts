// route-inventory: GET /e/:key
// Author-owned AP controls: execute actual SQL on a disposable schema. No fake
// preselects neighbors or filters statuses; renderer work must add zero reads.
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { kitEventDetailStore, resolveKitEventDetail } from "../src/events/kit-detail";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { adjacentKey } from "./helpers/event-adjacent-preview";
import { renderSeriesDetail } from "./helpers/event-series-context-render";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

let fixture: MemberDataFixture;
let db: Db;
let reject: "series" | "global" | null = null;
const traces: { sql: string; params: unknown[]; rows: number; columns: string[] }[] = [];
const isSeries = (sql: string) => /\bwhere\b[\s\S]*"parent_event_id"\s*(?:=|in\b)/i.test(sql);
const isGlobal = (sql: string) => /"starts_at"\s*[<>]/.test(sql) && !isSeries(sql);
const env = () =>
  ({
    APP_URL: "https://adjacent.example.test",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: createMemorySessionStore(),
    ADMIN_DB: db,
  }) as unknown as Env;

beforeAll(async () => {
  fixture = await createMemberDataFixture(
    process.env.DATABASE_URL ?? "postgres://agent_test@agent-testdb:5432/postgres",
  );
  db = drizzle(async (sql, params) => {
    const trace = { sql, params, rows: 0, columns: [] as string[] };
    traces.push(trace);
    if ((reject === "series" && isSeries(sql)) || (reject === "global" && isGlobal(sql)))
      throw new Error("decorative fixture read rejected");
    const raw = await fixture.client.unsafe(sql, params as never[]).raw();
    trace.rows = raw.length;
    trace.columns = raw.columns.map((c) => c.name);
    return {
      rows: raw.map((r) =>
        r.map((v, i) => {
          if (v === null) return null;
          const c = raw.columns[i]!;
          const s = v.toString();
          return [1114, 1184].includes(c.type) ? s : c.parser ? c.parser(s) : s;
        }),
      ),
    };
  }) as unknown as Db;
});
afterAll(async () => fixture?.dispose());
beforeEach(async () => {
  await fixture.reset();
  reject = null;
  await fixture.client`
    insert into events (id, event_key, title, starts_at, ends_at, timezone, location,
      status, parent_event_id, recurrence_index, recurrence_frequency, organizer_name)
    values
      (10, ${adjacentKey(10)}, 'Friday game night', '2030-06-21T19:00Z', '2030-06-21T21:00Z', 'Europe/London', 'Series previous room', 'past', null, 1, 'weekly', 'Riley'),
      (20, ${adjacentKey(20)}, 'Current night', '2030-06-14T19:00Z', '2030-06-14T21:00Z', 'UTC', 'Current lobby', 'published', 10, 3, null, 'Jo'),
      (30, ${adjacentKey(30)}, 'Friday game night', '2030-06-07T19:00Z', '2030-06-07T21:00Z', 'America/New_York', 'Series next room', 'published', 10, 5, null, 'Sam'),
      (15, ${adjacentKey(15)}, 'Friday game night', '2030-06-13T19:00Z', '2030-06-13T21:00Z', 'UTC', 'Global previous room', 'published', null, null, null, null),
      (25, ${adjacentKey(25)}, 'Friday game night', '2030-06-15T19:00Z', '2030-06-15T21:00Z', 'UTC', 'Global next room', 'published', null, null, null, null),
      (21, ${adjacentKey(21)}, 'Hidden draft', '2030-06-14T18:59Z', '2030-06-14T21:00Z', 'UTC', 'Hidden venue', 'draft', 10, 2, null, 'Hidden draft host'),
      (22, ${adjacentKey(22)}, 'Hidden cancelled', '2030-06-14T19:01Z', '2030-06-14T21:00Z', 'UTC', 'Hidden venue', 'cancelled', 10, 4, null, 'Hidden cancelled host'),
      (5, ${adjacentKey(5)}, 'Ended event', '2020-06-14T19:00Z', '2020-06-14T21:00Z', 'UTC', null, 'published', null, null, null, null)
  `;
  traces.length = 0;
});

async function render(twin: "Hono" | "Kit", id = 20) {
  const configured = env();
  if (twin === "Hono") {
    const response = await app.request(`/e/${adjacentKey(id)}`, {}, configured);
    expect(response.status).toBe(200);
    return { html: await response.text(), headers: Object.fromEntries(response.headers) };
  }
  const outcome = await resolveKitEventDetail({
    key: adjacentKey(id),
    search: "",
    path: `/e/${adjacentKey(id)}`,
    env: configured,
    session: { status: "guest", session: null },
    joinResult: null,
    setHeaders: () => {},
    store: kitEventDetailStore(configured),
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error(`Expected ok, got ${outcome.kind}`);
  return {
    html: await renderSeriesDetail(outcome.model as unknown as Record<string, unknown>),
    headers: outcome.headers,
  };
}
function target(html: string, id: string) {
  const anchor = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].find((m) =>
    m[0].includes(`data-testid="${id}"`),
  )?.[0];
  expect(anchor, id).toBeDefined();
  return /href="([^"]+)"/.exec(anchor!)?.[1];
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} adjacent previews preserve production read contracts`, () => {
    it("AP07 CONTROL: global chronology differs from series index without extra queries or private reads", async () => {
      const { html, headers } = await render(twin);
      expect(target(html, "event-previous")).toBe(`/e/${adjacentKey(15)}`);
      expect(target(html, "event-next")).toBe(`/e/${adjacentKey(25)}`);
      expect(target(html, "event-series-previous")).toBe(`/e/${adjacentKey(10)}`);
      expect(target(html, "event-series-next")).toBe(`/e/${adjacentKey(30)}`);
      expect(html).not.toMatch(/Hidden draft|Hidden cancelled|Hidden venue|Ended event/);
      expect(headers["cache-control"]).toBe("private, no-store");
      expect(headers["vary"]).toBe("Cookie");
      expect(traces).toHaveLength(7); // detail + two aggregates + two neighbors + related + series
      expect(traces.filter((q) => q.sql.includes('"event_key" ='))).toHaveLength(1);
      expect(traces.filter((q) => /member_data_access_logs|from "users"/.test(q.sql))).toHaveLength(
        0,
      );
      const series = traces.filter((q) => isSeries(q.sql));
      expect(series).toHaveLength(1);
      expect(series[0]!.rows).toBe(3);
      expect(series[0]!.columns).toHaveLength(9);
      const limit = /\blimit\s+\$(\d+)/i.exec(series[0]!.sql);
      expect(limit).not.toBeNull();
      expect(series[0]!.params[Number(limit![1]) - 1]).toBe(53);
      expect(series[0]!.sql.split(/\bfrom\b/i)[0]).not.toMatch(
        /description|join_url|join_instructions/,
      );
    });

    it.each(["series", "global"] as const)(
      "AP08 CONTROL: failed %s decorative read does not take down detail or the other rail",
      async (failure) => {
        reject = failure;
        const { html, headers } = await render(twin);
        expect(html).toContain("Current night");
        expect(html).toContain('data-island="rsvp-button"');
        expect(headers["cache-control"]).toBe("private, no-store");
        expect(html).not.toContain(
          `data-testid="${failure === "series" ? "event-series-nav" : "event-pagination"}"`,
        );
        expect(target(html, failure === "series" ? "event-next" : "event-series-next")).toBe(
          `/e/${adjacentKey(failure === "series" ? 25 : 30)}`,
        );
        expect(traces).toHaveLength(7);
      },
    );

    it("AP09 CONTROL: standalone has no series query and keeps the six-read global path", async () => {
      const { html } = await render(twin, 15);
      expect(html).toContain('data-testid="event-pagination"');
      expect(html).not.toContain('data-testid="event-series-nav"');
      expect(traces).toHaveLength(6);
      expect(traces.filter((q) => isSeries(q.sql))).toHaveLength(0);
    });
  });
}
