// route-inventory: GET /api/public/events
// Test Author owned: clamped pages share one real cache entry, cannot evict
// page 1 by raw-page alias flooding, and replay without another event read.
// OpenAPI supplies the page ceiling; no test-only numeric ceiling is invented.
// Real routes, cache, serialization and validators; only external read/admission
// edges are stubbed. No database, network, sleeps, or implementation changes.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { listPublicApiEvents, type PublicApiEvent } from "../src/events/reads";
import * as cache from "../src/public-data/cache";
import { getOpenApiDocument } from "../src/public-data/openapi";
import { registerPublicApiRoutes } from "../src/public-data/routes";

vi.mock("../src/admin/db", () => ({ dbFor: async () => ({}) }));
vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  listPublicApiEvents: vi.fn(),
}));
vi.mock("../src/events/routes-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/routes-shared")>()),
  publicReadGuard: async () => null,
}));

const ORIGIN = "https://next.example.test";
const T0 = Date.parse("2099-01-01T00:00:00Z");
const list = vi.mocked(listPublicApiEvents);
const row = (n: number): PublicApiEvent => ({
  id: n,
  eventKey: String(n).padStart(26, "0"),
  title: `Night ${n}`,
  game: null,
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
  createdAt: new Date(T0),
  updatedAt: new Date(T0),
  icsSequence: 0n,
  goingCount: 0,
  goingOccupancy: 0,
});

// Hand-specified public bytes, independent of production serializers.
const dto = (n: number) => ({
  event_key: String(n).padStart(26, "0"),
  title: `Night ${n}`,
  game: null,
  description: null,
  starts_at: "2099-11-04T20:00:00.000Z",
  ends_at: "2099-11-04T22:00:00.000Z",
  starts_at_local: "2099-11-04 20:00",
  ends_at_local: "2099-11-04 22:00",
  timezone: "UTC",
  location: null,
  capacity: null,
  going_count: 0,
  going_occupancy: 0,
  status: "published",
  rsvp_open: true,
  synced_to_discord: false,
});

function fixture(total = 1) {
  // Model the existing read boundary: count, clamp to last page, then rows.
  // The route must normalize its own keys; the fake never touches the cache.
  list.mockImplementation(async (_db, { limit, offset }) => {
    const page = Math.min(
      Math.max(1, Math.floor(offset / limit) + 1),
      Math.max(1, Math.ceil(total / limit)),
    );
    const start = (page - 1) * limit;
    return {
      rows: Array.from({ length: Math.min(limit, Math.max(0, total - start)) }, (_, i) =>
        row(start + i + 1),
      ),
      total,
      page,
    };
  });
  const app = new Hono<{ Bindings: Env }>();
  registerPublicApiRoutes(app);
  return (query = "", headers?: HeadersInit) =>
    app.request(`${ORIGIN}/api/public/events${query}`, { headers }, { APP_URL: ORIGIN } as Env);
}

async function bytes(res: Response) {
  expect(res.status).toBe(200);
  return res.text();
}

function liveWrittenKeys(writes: {
  mock: { calls: Parameters<typeof cache.writeApiPublicCache>[] };
}) {
  const keys = new Set(writes.mock.calls.map(([key]) => key));
  return [...keys].filter((key) => cache.readApiPublicCache(key) !== null);
}

describe("public event paging: canonical cache and bounded input (offline)", () => {
  beforeEach(() => {
    cache.__resetApiPublicCacheForTests();
    list.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(T0);
    vi.stubGlobal("fetch", () => {
      throw new Error("Network is forbidden in paging acceptance");
    });
  });
  afterEach(() => {
    cache.__resetApiPublicCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stores a cold out-of-range response under its clamped page, not its raw alias", async () => {
    const writes = vi.spyOn(cache, "writeApiPublicCache");
    const get = fixture(3);
    const text = await bytes(await get("?per_page=2&page=70"));
    expect(JSON.parse(text)).toMatchObject({ page: 2, meta: { current_page: 2, last_page: 2 } });
    expect(liveWrittenKeys(writes)).toEqual(["GET /api/public/events?limit=2&page=2"]);
    expect(cache.readApiPublicCache("GET /api/public/events?limit=2&page=2")?.body).toBe(text);
  });

  it("replays an out-of-range alias and its canonical page without another read", async () => {
    const get = fixture(3);
    const first = await get("?per_page=2&page=70");
    const etag = first.headers.get("etag");
    const text = await bytes(first);
    list.mockClear();
    for (const query of ["?per_page=2&page=70", "?per_page=2&page=2"]) {
      const replay = await get(query);
      expect(await bytes(replay)).toBe(text);
      expect(replay.headers.get("etag")).toBe(etag);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("a page=2..70 sweep occupies one entry when all requests clamp to page 1", async () => {
    const writes = vi.spyOn(cache, "writeApiPublicCache");
    const get = fixture();
    const expected = await bytes(await get("?page=1"));
    for (let page = 2; page <= 70; page++) {
      expect(await bytes(await get(`?page=${page}`)), `page ${page}`).toBe(expected);
    }
    expect(liveWrittenKeys(writes)).toEqual(["GET /api/public/events?limit=20&page=1"]);
  });

  it("page 1 remains a cache hit after more out-of-range aliases than the FIFO capacity", async () => {
    const get = fixture();
    const original = await get("?page=1");
    const etag = original.headers.get("etag")!;
    const text = await bytes(original);
    for (let page = 2; page <= 70; page++) await bytes(await get(`?page=${page}`));
    list.mockClear();
    expect(await bytes(await get("?page=1"))).toBe(text);
    const conditional = await get("?page=1", { "if-none-match": etag });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps distinct in-range pages and sizes separate while limit aliases share hits", async () => {
    const get = fixture(3);
    const first = await bytes(await get("?per_page=2&page=1"));
    const second = await bytes(await get("?per_page=2&page=2"));
    const smaller = await bytes(await get("?per_page=1&page=1"));
    expect(JSON.parse(first).data.map((event: { title: string }) => event.title)).toEqual([
      "Night 1",
      "Night 2",
    ]);
    expect(JSON.parse(second).data.map((event: { title: string }) => event.title)).toEqual([
      "Night 3",
    ]);
    expect(JSON.parse(smaller).data.map((event: { title: string }) => event.title)).toEqual([
      "Night 1",
    ]);
    list.mockClear();
    expect(await bytes(await get("?limit=2&page=1&ignored=anything"))).toBe(first);
    expect(await bytes(await get("?limit=2&page=2"))).toBe(second);
    expect(await bytes(await get("?limit=1&page=1"))).toBe(smaller);
    expect(list).not.toHaveBeenCalled();
  });

  it("an empty collection also keeps just its canonical page-1 entry", async () => {
    const writes = vi.spyOn(cache, "writeApiPublicCache");
    const get = fixture(0);
    for (const page of [2, 3, 70]) {
      expect(JSON.parse(await bytes(await get(`?page=${page}`)))).toEqual({
        data: [],
        page: 1,
        limit: 20,
        meta: { current_page: 1, per_page: 20, total: 0, last_page: 1 },
      });
    }
    expect(liveWrittenKeys(writes)).toEqual(["GET /api/public/events?limit=20&page=1"]);
  });

  it("never passes an infinite or unsafe offset to the reader for an enormous raw page", async () => {
    const get = fixture();
    await bytes(await get(`?page=${"9".repeat(400)}`));
    const opts = list.mock.calls[0]![1];
    expect(Number.isSafeInteger(opts.offset)).toBe(true);
    expect(opts.offset).toBeGreaterThanOrEqual(0);
  });

  it("caps raw pages at the OpenAPI ceiling before constructing lookup keys and offsets", async () => {
    const parameters = getOpenApiDocument(ORIGIN).paths["/api/public/events"].get.parameters;
    const pageSchema = parameters.find((p) => p.name === "page")?.schema as { maximum?: number };
    const max = pageSchema.maximum;
    expect(Number.isSafeInteger(max), "OpenAPI must advertise a finite page ceiling").toBe(true);
    expect(max).toBeGreaterThan(1);
    const keyCalls = vi.spyOn(cache, "apiPublicCacheKey");
    const get = fixture();
    for (const raw of [String(max), String(max! + 1), "9007199254740991", "9".repeat(400)]) {
      cache.__resetApiPublicCacheForTests();
      list.mockClear();
      keyCalls.mockClear();
      await bytes(await get(`?page=${raw}`));
      expect(list.mock.calls[0]![1]).toEqual({ limit: 20, offset: (max! - 1) * 20 });
      expect(Number.isSafeInteger(list.mock.calls[0]![1].offset)).toBe(true);
      expect(keyCalls.mock.calls.length).toBeGreaterThan(0);
      for (const [, , query] of keyCalls.mock.calls) {
        const keyedPage = Number(new URLSearchParams(query).get("page"));
        expect(keyedPage).toBeGreaterThanOrEqual(1);
        expect(keyedPage).toBeLessThanOrEqual(max!);
      }
    }
  });

  it.each([
    { query: "?per_page=2&page=1", page: 1, ids: [1, 2] },
    { query: "?per_page=2&page=2", page: 2, ids: [3] },
  ])(
    "preserves in-range response bytes, ETag and 200/304 for $query",
    async ({ query, page, ids }) => {
      const get = fixture(3);
      const expected = JSON.stringify({
        data: ids.map(dto),
        page,
        limit: 2,
        meta: { current_page: page, per_page: 2, total: 3, last_page: 2 },
      });
      const etag = `"${createHash("sha1").update(expected).digest("hex")}"`;
      for (let replay = 0; replay < 2; replay++) {
        const res = await get(query);
        expect(await bytes(res)).toBe(expected);
        expect(res.headers.get("etag")).toBe(etag);
        expect(res.headers.get("content-type")).toBe("application/json; charset=UTF-8");
        const conditional = await get(query, { "if-none-match": etag });
        expect(conditional.status).toBe(304);
        expect(conditional.headers.get("etag")).toBe(etag);
        expect(await conditional.text()).toBe("");
      }
    },
  );

  it.each([
    { query: "", limit: 20, offset: 0 },
    { query: "?page=garbage", limit: 20, offset: 0 },
    { query: "?page=0", limit: 20, offset: 0 },
    { query: "?page=-4", limit: 20, offset: 0 },
    { query: "?per_page=garbage", limit: 20, offset: 0 },
    { query: "?per_page=1.5", limit: 20, offset: 0 },
    { query: "?per_page=0", limit: 1, offset: 0 },
    { query: "?per_page=-4", limit: 1, offset: 0 },
    { query: "?per_page=999", limit: 20, offset: 0 },
    { query: "?limit=2&page=2", limit: 2, offset: 2 },
    { query: "?limit=garbage", limit: 20, offset: 0 },
    { query: "?limit=0", limit: 1, offset: 0 },
    { query: "?limit=999", limit: 20, offset: 0 },
    { query: "?per_page=2&limit=1", limit: 2, offset: 0 },
    { query: "?per_page=garbage&limit=1", limit: 20, offset: 0 },
  ])(
    "coerces $query without a new 422 and preserves the read bounds",
    async ({ query, limit, offset }) => {
      const get = fixture(3);
      const res = await get(query);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ limit, meta: { per_page: limit } });
      expect(list.mock.calls[0]![1]).toEqual({ limit, offset });
    },
  );
});
