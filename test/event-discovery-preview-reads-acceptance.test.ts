// route-inventory: GET /e/:key
// Independent Test-Author contract: execute real SQL only in an owned test
// schema. Builder keeps this file unchanged. Run with the render acceptance:
// npx vitest run test/event-discovery-preview*-acceptance.test.ts
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminSchema, schema, type Db } from "../src/db/index";
import type { Env } from "../src/env";
import { kitEventDetailStore, resolveKitEventDetail } from "../src/events/kit-detail";
import { getEventNeighbors, getEventSeriesContext, listRelatedEvents } from "../src/events/reads";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { adjacentEvent, adjacentKey, type DetailTwin } from "./helpers/event-adjacent-preview";
import { renderSeriesDetail } from "./helpers/event-series-context-render";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = new Date("2026-11-01T18:00:00.000Z");
const current = adjacentEvent(20, {
  game: "Current game",
  startsAt: new Date("2026-11-08T18:00:00Z"),
  endsAt: new Date("2026-11-08T20:00:00Z"),
  parentEventId: 10,
  recurrenceIndex: 2,
});
let fixture: MemberDataFixture;
let db: Db;
const queries: { sql: string; params: unknown[] }[] = [];

beforeAll(async () => {
  fixture = await createMemberDataFixture(
    process.env.DATABASE_URL ?? "postgres://agent_test@agent-testdb:5432/postgres",
  );
  db = drizzle(fixture.client, {
    schema: { ...schema, ...adminSchema },
    logger: { logQuery: (sql, params) => queries.push({ sql, params }) },
  });
});
afterAll(async () => fixture?.dispose());
beforeEach(async () => {
  await fixture.reset();
  await fixture.client`
    insert into events (id, event_key, title, game, starts_at, ends_at, timezone,
      location, status, rsvp_open, parent_event_id, recurrence_index, recurrence_frequency)
    values
      (10, ${adjacentKey(10)}, 'Earlier series night', 'Earlier game', '2026-10-25T18:00Z', '2026-10-25T20:00Z', 'UTC', 'Earlier room', 'past', true, null, 1, 'weekly'),
      (20, ${adjacentKey(20)}, 'Current night', 'Current game', '2026-11-08T18:00Z', '2026-11-08T20:00Z', 'UTC', 'Current room', 'published', true, 10, 2, null),
      (30, ${adjacentKey(30)}, 'Later series night', null, '2026-11-15T18:00Z', '2026-11-15T20:00Z', 'UTC', null, 'published', false, 10, 3, null),
      (15, ${adjacentKey(15)}, 'Global previous night', 'Co-op', '2026-11-07T18:00Z', '2026-11-07T20:00Z', 'America/New_York', 'Previous room', 'published', false, null, null, null),
      (25, ${adjacentKey(25)}, 'Global next night', 'Current game', '2026-11-09T18:00Z', '2026-11-09T20:00Z', 'UTC', 'Next room', 'published', true, null, null, null),
      (21, ${adjacentKey(21)}, 'Hidden draft', 'Private game', '2026-11-08T17:59Z', '2026-11-08T20:00Z', 'UTC', null, 'draft', false, 10, 4, null),
      (22, ${adjacentKey(22)}, 'Hidden cancelled', 'Private game', '2026-11-08T18:01Z', '2026-11-08T20:00Z', 'UTC', null, 'cancelled', false, 10, 5, null)
  `;
  queries.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function discovery() {
  const neighbors = await getEventNeighbors(db, current, NOW);
  const related = await listRelatedEvents(db, current, NOW);
  const series = await getEventSeriesContext(db, current);
  return { neighbors, related, series };
}
async function render(twin: DetailTwin, id = 20) {
  const env = {
    APP_URL: "https://example.test",
    ADMIN_DB: db,
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: createMemorySessionStore(),
  } as unknown as Env;
  if (twin === "Hono") {
    const response = await app.request(`/e/${adjacentKey(id)}`, {}, env);
    expect(response.status).toBe(200);
    return response.text();
  }
  const outcome = await resolveKitEventDetail({
    key: adjacentKey(id),
    search: "",
    path: `/e/${adjacentKey(id)}`,
    env,
    session: { status: "guest", session: null },
    joinResult: null,
    setHeaders: () => {},
    store: kitEventDetailStore(env),
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") throw new Error(`Expected ok, got ${outcome.kind}`);
  return renderSeriesDetail(outcome.model as unknown as Record<string, unknown>);
}
function link(html: string, testid: string): string {
  const found = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].find((m) =>
    m[0].includes(`data-testid="${testid}"`),
  );
  expect(found, testid).toBeDefined();
  return found![0];
}
function expectDetailBudget(total: number, currentId: number) {
  expect(queries).toHaveLength(total);
  const aggregates = queries.filter((q) => /\bfrom "rsvps"/.test(q.sql));
  expect(aggregates).toHaveLength(2); // Existing detail counts, never preview counts.
  for (const query of aggregates) {
    expect(query.sql).toMatch(/\bcount\(/i);
    expect(query.params.filter((p) => typeof p === "number")).toEqual([currentId]);
  }
  expect(queries.filter((q) => /member_data_access_logs|web_sessions/.test(q.sql))).toHaveLength(0);
}

describe("discovery reads carry row-local preview data", () => {
  it("RED: global neighbors retain their own game, end instant and pause flag", async () => {
    const neighbors = await getEventNeighbors(db, current, NOW);
    expect(neighbors.previous).toMatchObject({
      id: 15,
      game: "Co-op",
      endsAt: new Date("2026-11-07T20:00:00Z"),
      rsvpOpen: false,
    });
    expect(neighbors.next).toMatchObject({
      id: 25,
      game: "Current game",
      endsAt: new Date("2026-11-09T20:00:00Z"),
      rsvpOpen: true,
    });
  });

  it("RED: related results retain game/null and RSVP data without changing ranking", async () => {
    const related = await listRelatedEvents(db, current, NOW);
    expect(related.map((row) => row.id)).toEqual([25, 15, 30]);
    expect(related).toMatchObject([
      { id: 25, game: "Current game", rsvpOpen: true, endsAt: new Date("2026-11-09T20:00:00Z") },
      { id: 15, game: "Co-op", rsvpOpen: false, endsAt: new Date("2026-11-07T20:00:00Z") },
      { id: 30, game: null, rsvpOpen: false, endsAt: new Date("2026-11-15T20:00:00Z") },
    ]);
  });

  it("RED: series projection and mapping retain an ended sibling and a game-less next night", async () => {
    const series = await getEventSeriesContext(db, current);
    expect(series?.previous).toMatchObject({
      id: 10,
      game: "Earlier game",
      endsAt: new Date("2026-10-25T20:00:00Z"),
      rsvpOpen: true,
    });
    expect(series?.next).toMatchObject({
      id: 30,
      game: null,
      endsAt: new Date("2026-11-15T20:00:00Z"),
      rsvpOpen: false,
    });
  });

  it("CONTROL: all previews use the same four queries and zero RSVP reads", async () => {
    const result = await discovery();
    expect(result.neighbors.previous?.id).toBe(15);
    expect(result.neighbors.next?.id).toBe(25);
    expect(result.series?.previous?.id).toBe(10);
    expect(result.series?.next?.id).toBe(30);
    expect(result.related.map((row) => row.id)).toEqual([25, 15, 30]);
    expect(queries).toHaveLength(4); // Two neighbors, one related, one series.
    for (const query of queries) {
      expect(query.sql).not.toMatch(/rsvps|\bcount\(|\bjoin\b/i);
      expect(query.sql.split(/\bfrom\b/i)[0]).not.toMatch(/description|join_instructions|join_url/);
    }
  });
});

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} production detail read path`, () => {
    it("RED: keeps distinct preview metadata on each rail from SQL through SSR", async () => {
      const html = await render(twin);
      const previous = link(html, "event-previous");
      expect(previous).toContain(`href="/e/${adjacentKey(15)}"`);
      expect(previous).toContain("Co-op");
      expect(previous).toContain("RSVPs paused");
      expect(previous).not.toMatch(/Earlier game|Ended|Past event/i);
      const earlier = link(html, "event-series-previous");
      expect(earlier).toContain(`href="/e/${adjacentKey(10)}"`);
      expect(earlier).toContain("Earlier game");
      expect(earlier).toMatch(/\b(?:Ended|Past event)\b/i);
      expect(earlier).not.toContain("RSVPs paused");
      const later = link(html, "event-series-next");
      expect(later).toContain(`href="/e/${adjacentKey(30)}"`);
      expect(later).toContain("RSVPs paused");
      expect(later).not.toMatch(/Current game|Co-op|Earlier game|Ended|Past event/i);
      expect(link(html, "event-next")).toContain("Current game");
      const related = [
        ...html.matchAll(/<a\b[^>]*data-testid="event-related-link"[^>]*>[\s\S]*?<\/a>/g),
      ];
      expect(related).toHaveLength(3);
      expect(related[0]![0]).toContain(`href="/e/${adjacentKey(25)}"`);
      expect(related[0]![0]).toContain("Current game");
      expect(related[1]![0]).toContain("RSVPs paused");
      expect(html).not.toMatch(/Hidden draft|Hidden cancelled|Private game/);
    });

    it("CONTROL: series detail stays at eight reads with RSVP counts only for the current event", async () => {
      await render(twin);
      expectDetailBudget(8, 20); // Includes the bounded published-game catalog read.
    });

    it("CONTROL: unrelated extra events do not add reads or aggregate preview RSVPs", async () => {
      await fixture.client`
        insert into events (id, event_key, title, starts_at, ends_at, status)
        select n, lpad(n::text, 26, '0'), 'Extra future night', '2027-01-01T18:00Z'::timestamptz,
          '2027-01-01T20:00Z'::timestamptz, 'published' from generate_series(100, 149) as n
      `;
      const html = await render(twin);
      expectDetailBudget(8, 20); // Includes the bounded published-game catalog read.
      expect([...html.matchAll(/data-testid="event-related-link"/g)]).toHaveLength(3);
    });

    it("CONTROL: standalone detail stays at seven reads and has no series rail", async () => {
      const html = await render(twin, 15);
      expectDetailBudget(7, 15); // Includes the bounded published-game catalog read.
      expect(html).not.toContain('data-testid="event-series-nav"');
      expect(html).toContain('data-testid="event-pagination"');
    });
  });
}
