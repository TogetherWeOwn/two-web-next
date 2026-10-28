// route-inventory: GET /api/public/events
// Review regressions beside the protected acceptance suite. Real routes,
// reader and cache; only database transport and read admission are fixtures.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { listPublicApiEvents } from "../src/events/reads";
import { __resetApiPublicCacheForTests, retireApiPublicEventCache } from "../src/public-data/cache";
import type { PublicApiEventCollectionDto } from "../src/public-data/contracts";
import { registerPublicApiRoutes } from "../src/public-data/routes";

const dbBox = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/admin/db", () => ({ dbFor: async () => dbBox.db as Db }));
vi.mock("../src/events/routes-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/routes-shared")>()),
  publicReadGuard: async () => null,
}));

const ORIGIN = "https://public-games.example.test";
const EMPTY = {
  data: [],
  page: 1,
  limit: 20,
  meta: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
};
type EventRow = typeof events.$inferSelect;

function eventRow(id: number, game: string): EventRow {
  return {
    id,
    eventKey: String(id).padStart(26, "0"),
    title: `Night ${id}`,
    game,
    description: null,
    accessibilityNotes: null,
    startsAt: new Date("2099-11-04T20:00:00Z"),
    endsAt: new Date("2099-11-04T22:00:00Z"),
    timezone: "UTC",
    location: null,
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    syncRevision: 1,
    syncedRevision: 0,
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
    createdAt: new Date("2099-01-01T00:00:00Z"),
    updatedAt: new Date("2099-01-01T00:00:00Z"),
    icsSequence: 0n,
  };
}

function fixture(games = ["Chess", "Catan"], afterCount?: () => void) {
  const rows = games.map((game, i) => eventRow(i + 1, game));
  const queries: { sql: string; params: unknown[] }[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof EventRow)[];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params: [...params] });
    if (sql.includes('from "rsvps"')) return { rows: [] };
    const match = /"game"\)\) = \$(\d+)/.exec(sql);
    const game = match ? params[Number(match[1]) - 1] : undefined;
    const visible = rows.filter(
      (row) => game === undefined || row.game!.trim().toLowerCase() === game,
    );
    if (/^select count/i.test(sql)) {
      afterCount?.();
      return { rows: [[visible.length]] };
    }
    const offset = sql.includes(" offset ") ? Number(params.at(-1)) : 0;
    const limit = Number(params.at(sql.includes(" offset ") ? -2 : -1));
    return {
      rows: visible.slice(offset, offset + limit).map((row) =>
        columns.map((key) => {
          const value = row[key];
          return value instanceof Date ? value.toISOString() : value;
        }),
      ),
    };
  }) as unknown as Db;
  dbBox.db = db;
  const app = new Hono<{ Bindings: Env }>();
  registerPublicApiRoutes(app);
  return {
    db,
    queries,
    get: (query: string, headers?: HeadersInit) =>
      app.request(`${ORIGIN}/api/public/events${query}`, { headers }, { APP_URL: ORIGIN } as Env),
  };
}

beforeEach(() => {
  __resetApiPublicCacheForTests();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00Z"));
  vi.stubGlobal("fetch", () => {
    throw new Error("Network is forbidden in game-filter regressions");
  });
});
afterEach(() => {
  __resetApiPublicCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public game filter review regressions (offline)", () => {
  it.each(["\0", "Chess\0", "Chess\u0001"])(
    "route refuses control-bearing game %j before any query",
    async (game) => {
      const h = fixture();
      // The route refusal must not depend on a database being available;
      // otherwise the reader's twin guard could mask a missing route guard.
      dbBox.db = null;
      const response = await h.get(`?game=${encodeURIComponent(game)}&per_page=1&page=99`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(EMPTY);
      expect(h.queries).toHaveLength(0);
      expect(response.headers.get("cache-control")).toBe("public, max-age=60");
      const etag = response.headers.get("etag");
      expect(etag).toBeTruthy();
      const replay = await h.get(`?game=${encodeURIComponent(game)}`, { "if-none-match": etag! });
      expect(replay.status).toBe(304);
      expect(await replay.text()).toBe("");
      expect(h.queries).toHaveLength(0);
    },
  );

  it.each(["", "   ", "C".repeat(101), "🎲".repeat(101), "\0", "Chess\0", "Chess\u0001"])(
    "reader refuses invalid game %j before any query",
    async (game) => {
      const h = fixture();
      expect(await listPublicApiEvents(h.db, { game, limit: 1, offset: 99 })).toEqual({
        rows: [],
        total: 0,
        page: 1,
      });
      expect(h.queries).toHaveLength(0);
    },
  );

  it.each(["C".repeat(100), "🎲".repeat(100)])(
    "route admits a stored game of exactly 100 code points (%j)",
    async (game) => {
      const h = fixture([game, "Other"]);
      const response = await h.get(`?game=${encodeURIComponent(game)}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as PublicApiEventCollectionDto;
      expect(body.data.map((row) => row.title)).toEqual(["Night 1"]);
      expect(body.data.map((row) => row.game)).toEqual([game]);
      expect(body.meta.total).toBe(1);
      expect(h.queries.filter((query) => query.sql.includes('from "events"'))).toHaveLength(2);
    },
  );

  it.each(["C".repeat(100), "🎲".repeat(100)])(
    "reader admits a stored game of exactly 100 code points (%j)",
    async (game) => {
      const h = fixture([game, "Other"]);
      const listed = await listPublicApiEvents(h.db, { game, limit: 20, offset: 0 });
      expect(listed.rows.map((row) => row.title)).toEqual(["Night 1"]);
      expect(listed.rows.map((row) => row.game)).toEqual([game]);
      expect(listed.total).toBe(1);
      expect(h.queries.filter((query) => query.sql.includes('from "events"'))).toHaveLength(2);
    },
  );

  it.each(["C".repeat(101), "🎲".repeat(101)])(
    "route rejects 101 code points before reading even a matching fixture (%j)",
    async (game) => {
      const h = fixture([game]);
      const response = await h.get(`?game=${encodeURIComponent(game)}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(EMPTY);
      expect(h.queries).toHaveLength(0);
    },
  );

  it("does not let distinct unknown games evict a primed useful cache entry", async () => {
    const h = fixture();
    const chess = await (await h.get("?game=Chess")).text();
    expect(JSON.parse(chess).data.map((row: { title: string }) => row.title)).toEqual(["Night 1"]);
    for (let i = 0; i < 70; i++) {
      const response = await h.get(`?game=Unknown${i}&per_page=${(i % 20) + 1}&page=99`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(EMPTY);
    }
    const reads = h.queries.length;
    expect(reads).toBeGreaterThan(0);
    expect(await (await h.get("?game=Chess")).text()).toBe(chess);
    expect(h.queries).toHaveLength(reads);
  });

  it("keeps ETag/304 for uncached unknown games and rereads after a publish", async () => {
    const h = fixture();
    const response = await h.get("?game=Unknown&per_page=2&page=99");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(EMPTY);
    expect(response.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    const reads = h.queries.length;
    const replay = await h.get("?game=Unknown&per_page=2", { "if-none-match": etag! });
    expect(replay.status).toBe(304);
    expect(await replay.text()).toBe("");
    expect(replay.headers.get("etag")).toBe(etag);
    expect(replay.headers.get("cache-control")).toBe("public, max-age=60");
    expect(h.queries.length).toBeGreaterThan(reads);
    const published = fixture(["Unknown"]);
    const fresh = await published.get("?game=Unknown&per_page=2", { "if-none-match": etag! });
    expect(fresh.status).toBe(200);
    expect(
      ((await fresh.json()) as PublicApiEventCollectionDto).data.map((row) => row.title),
    ).toEqual(["Night 1"]);
  });

  it("does not grant downstream freshness to an unknown-game read overtaken by retirement", async () => {
    const h = fixture(["Chess"], retireApiPublicEventCache);
    const response = await h.get("?game=Unknown");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(EMPTY);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });
});
