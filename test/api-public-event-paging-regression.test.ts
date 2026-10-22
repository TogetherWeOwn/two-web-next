// route-inventory: GET /api/public/events
// Review regressions alongside the protected paging acceptance suite. Real
// routes/cache/serialization, mutable read snapshots, fake clock, no network.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { listPublicApiEvents, type PublicApiEvent } from "../src/events/reads";
import * as cache from "../src/public-data/cache";
import type { PublicApiEventCollectionDto } from "../src/public-data/contracts";
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

function fixture(initialTotal: number) {
  let total = initialTotal;
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
  return {
    // Models a publish in another isolate: this isolate's entries retain TTL.
    setTotal: (next: number) => {
      total = next;
    },
    get: (query: string) =>
      app.request(`${ORIGIN}/api/public/events${query}`, {}, { APP_URL: ORIGIN } as Env),
  };
}

const pageParameter = () =>
  getOpenApiDocument(ORIGIN).paths["/api/public/events"].get.parameters.find(
    (p) => p.name === "page",
  )!;

beforeEach(() => {
  cache.__resetApiPublicCacheForTests();
  list.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(T0);
  vi.stubGlobal("fetch", () => {
    throw new Error("Network is forbidden in paging regressions");
  });
});
afterEach(() => {
  cache.__resetApiPublicCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public event paging review regressions (offline)", () => {
  it("does not replay a non-final page from mixed pre/post-publish snapshots", async () => {
    const { get, setTotal } = fixture(3);
    expect(await (await get("?per_page=2&page=1")).json()).toMatchObject({
      page: 1,
      meta: { total: 3, last_page: 2 },
    });
    setTotal(9);
    expect(await (await get("?per_page=2&page=2")).json()).toMatchObject({
      page: 2,
      meta: { total: 9, last_page: 5 },
    });
    list.mockClear();
    const fourth = await get("?per_page=2&page=4");
    expect(fourth.status).toBe(200);
    const body = (await fourth.json()) as PublicApiEventCollectionDto;
    expect(body).toMatchObject({ page: 4, meta: { current_page: 4, total: 9, last_page: 5 } });
    expect(body.data.map((event: { title: string }) => event.title)).toEqual([
      "Night 7",
      "Night 8",
    ]);
    expect(list).toHaveBeenCalledExactlyOnceWith(expect.anything(), { limit: 2, offset: 6 });

    // No cached entry is the last page yet. Read it once, then replay only
    // that self-consistent final-page snapshot for other out-of-range aliases.
    list.mockClear();
    const last = await get("?per_page=2&page=70");
    expect(last.status).toBe(200);
    const text = await last.text();
    expect(JSON.parse(text)).toMatchObject({ page: 5, meta: { current_page: 5, last_page: 5 } });
    expect(list).toHaveBeenCalledExactlyOnceWith(expect.anything(), { limit: 2, offset: 138 });
    list.mockClear();
    const replay = await get("?per_page=2&page=80");
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(text);
    expect(replay.headers.get("etag")).toBe(last.headers.get("etag"));
    expect(list).not.toHaveBeenCalled();
  });

  it.each([-1, 0, 1])("pins the page ceiling and its neighbour at max offset %i", async (delta) => {
    const max = (pageParameter().schema as { maximum: number }).maximum;
    expect(Number.isSafeInteger(max)).toBe(true);
    expect(max).toBeGreaterThan(1);
    const { get } = fixture(max * 20);
    const keyCalls = vi.spyOn(cache, "apiPublicCacheKey");
    const page = Math.min(max + delta, max);
    const res = await get(`?page=${max + delta}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ page, meta: { current_page: page } });
    expect(list).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      limit: 20,
      offset: (page - 1) * 20,
    });
    expect(keyCalls).toHaveBeenCalledWith("GET", "/api/public/events", `?limit=20&page=${page}`);
    expect(keyCalls.mock.calls[0]).toEqual(["GET", "/api/public/events", `?limit=20&page=${page}`]);
  });

  it.each([
    ["2abc", 2],
    ["2.9", 2],
    [" 2", 2],
    ["+2", 2],
    ["garbage", 1],
    ["0", 1],
    ["-4", 1],
  ])("preserves documented integer-prefix coercion for page=%s", async (raw, page) => {
    const { get } = fixture(3);
    const res = await get(`?per_page=2&page=${encodeURIComponent(raw)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublicApiEventCollectionDto;
    expect(body).toMatchObject({ page, meta: { current_page: page } });
    expect(body.data.map((event: { title: string }) => event.title)).toEqual(
      page === 2 ? ["Night 3"] : ["Night 1", "Night 2"],
    );
    expect(list).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      limit: 2,
      offset: (page - 1) * 2,
    });
  });

  it("documents integer-prefix parsing rather than defaulting every malformed page", () => {
    const text = pageParameter().description;
    expect(text).toMatch(/leading integer prefix/i);
    expect(text).toContain("2abc");
    expect(text).toContain("2.9");
    expect(text).toMatch(/without an integer prefix/i);
    expect(text).toMatch(/below 1.*default 1/i);
  });
});
