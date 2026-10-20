import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";
import { listCalendarPast, listUpcoming, listUpcomingForMonth } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { recordSearch } from "../src/events/search-log";
import {
  discordNotices,
  PARTIAL_INVITE,
  partialEvent,
  partialHtml,
} from "./helpers/calendar-discord-partial";

// Read seams remove external SQL only. The model, empty-state decision,
// Hono route and Kit renderer stay real. Removing the failure guard should
// contaminate demand evidence; hiding healthy rows or notices should fail SSR.
vi.mock("../src/events/reads", async (original) => ({
  ...(await original<typeof import("../src/events/reads")>()),
  listUpcoming: vi.fn(),
  listUpcomingForMonth: vi.fn(),
  listCalendarPast: vi.fn(),
  persistedDiscordIds: vi.fn(async () => new Set<string>()),
}));
vi.mock("../src/events/search-log", async (original) => ({
  ...(await original<typeof import("../src/events/search-log")>()),
  recordSearch: vi.fn(async () => {}),
}));

const db = {} as Db;
const now = new Date("2099-05-01T12:00:00Z");
let failed = true;
const discord = {
  upcoming: vi.fn(async () => []),
  lastReadFailed: () => failed,
};
const env = {
  APP_URL: "https://calendar.example.test",
  DISCORD_INVITE_URL: PARTIAL_INVITE,
  ADMIN_DB: db,
  DISCORD_EVENTS: discord,
  // Synthetic sentinels must never appear in a rendered failure notice.
  DISCORD_BOT_TOKEN: "fixture-provider-secret-not-for-output",
} as unknown as Env;
const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => null,
  async () => null,
);

beforeEach(() => {
  vi.clearAllMocks();
  __resetAnonEventCacheForTests();
  failed = true;
  vi.mocked(listUpcoming).mockResolvedValue({
    rows: [partialEvent()],
    hasMore: false,
    totalPages: 1,
    total: 1,
  });
  vi.mocked(listUpcomingForMonth).mockResolvedValue([partialEvent()]);
  vi.mocked(listCalendarPast).mockResolvedValue([]);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function model(query: Parameters<typeof resolveCalendarInput>[0] = {}) {
  return loadCalendarPageModel({
    db,
    input: resolveCalendarInput(query),
    includeDrafts: false,
    discord,
    now,
  });
}
function emptyLocal() {
  vi.mocked(listUpcoming).mockResolvedValue({ rows: [], hasMore: false, totalPages: 0, total: 0 });
  vi.mocked(listUpcomingForMonth).mockResolvedValue([]);
}
function resultLogs() {
  return vi.mocked(console.info).mock.calls.filter(([name]) => name === "event_search");
}

describe("incomplete calendar search evidence", () => {
  it.each([0, 1])(
    "records neither demand nor result logs for %i visible local matches during source failure",
    async (count) => {
      if (!count) emptyLocal();
      const result = await model({ q: "chess" });
      expect(result.discordFailed).toBe(true);
      expect(result.upcoming).toHaveLength(count);
      expect(recordSearch).not.toHaveBeenCalled();
      expect(resultLogs()).toEqual([]);
    },
  );

  it("does not count a past-only incomplete search as complete evidence", async () => {
    emptyLocal();
    vi.mocked(listCalendarPast).mockResolvedValue([
      { ...partialEvent(2), startsAt: new Date("2020-01-01"), endsAt: new Date("2020-01-02") },
    ]);
    const result = await model({ q: "chess", past: "1" });
    expect(result.past).toHaveLength(1);
    expect(result.emptyState).toBe("error");
    expect(recordSearch).not.toHaveBeenCalled();
    expect(resultLogs()).toEqual([]);
  });

  it.each([0, 1])("still records a complete search with %i matches", async (count) => {
    failed = false;
    if (!count) emptyLocal();
    await model({ q: "  CHESS  " });
    expect(recordSearch).toHaveBeenCalledExactlyOnceWith(db, "  CHESS  ", count);
    expect(resultLogs()).toHaveLength(1);
    expect(JSON.parse(String(resultLogs()[0]![1]))).toEqual({
      event: "event_search",
      query: "chess",
      results: count,
    });
  });

  it.each([{}, { q: "   " }, { q: "chess", page: "2" }])(
    "retains the existing non-recording rules for %j",
    async (input) => {
      failed = false;
      await model(input);
      expect(recordSearch).not.toHaveBeenCalled();
      expect(resultLogs()).toEqual([]);
    },
  );

  it("records again after an incomplete read recovers, without replaying that read", async () => {
    await model({ q: "chess" });
    failed = false;
    await model({ q: "chess" });
    expect(recordSearch).toHaveBeenCalledExactlyOnceWith(db, "chess", 1);
    expect(resultLogs()).toHaveLength(1);
  });
});

describe("partial-source calendar rendering", () => {
  for (const adapter of ["Hono", "Kit"] as const) {
    async function render(input: Record<string, string>) {
      if (adapter === "Kit") return partialHtml(await model(input));
      const response = await app.request(`/events?${new URLSearchParams(input)}`, undefined, env);
      expect(response.status).toBe(200);
      return response.text();
    }

    it.each(["list", "calendar"])(
      `${adapter} preserves healthy %s rows and names the missing source accessibly`,
      async (view) => {
        const html = await render({ view, month: "2099-05", past: "1" });
        expect(html).toContain("Local chess night 1");
        expect(html).toContain(
          view === "list" ? 'data-testid="event-card"' : 'data-testid="events-calendar-grid"',
        );
        expect(html).not.toContain('data-testid="events-empty-error"');
        expect(
          discordNotices(html),
          "partial rows need an accessible missing-Discord notice",
        ).toHaveLength(1);
        expect(html).not.toContain("fixture-provider-secret-not-for-output");
        expect(html).not.toContain("discord.com/api/");
      },
    );

    it(`${adapter} preserves failed-empty search precedence instead of asserting no match`, async () => {
      emptyLocal();
      const html = await render({ q: "chess" });
      expect(html).toContain('data-testid="events-empty-error"');
      expect(html).not.toContain("Nothing matches that search");
      expect(html).not.toContain('data-testid="events-empty-search"');
    });

    it(`${adapter} keeps a successful genuine zero search distinct from source failure`, async () => {
      failed = false;
      emptyLocal();
      const html = await render({ q: "chess" });
      expect(html).toContain('data-testid="events-empty-search"');
      expect(html).not.toContain('data-testid="events-empty-error"');
      expect(discordNotices(html)).toEqual([]);
    });

    it(`${adapter} never invents a full outage or no-match on an out-of-range local page`, async () => {
      vi.mocked(listUpcoming).mockResolvedValue({
        rows: [],
        hasMore: false,
        totalPages: 2,
        total: 25,
      });
      const html = await render({ q: "chess", page: "9" });
      expect(html).toContain('data-testid="events-out-of-range"');
      expect(html).not.toContain('data-testid="events-empty-search"');
      expect(html).not.toContain('data-testid="events-empty-error"');
      expect(discordNotices(html)).toHaveLength(1);
    });

    it(`${adapter} shows healthy recovery without a stale missing-source warning`, async () => {
      failed = false;
      const html = await render({ month: "2099-05" });
      expect(html).toContain("Local chess night 1");
      expect(discordNotices(html)).toEqual([]);
    });
  }

  it("keeps too-long search refusal ahead of source reads and analytics", async () => {
    const response = await app.request(`/events?q=${"x".repeat(256)}`, undefined, env);
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(discord.upcoming).not.toHaveBeenCalled();
    expect(listUpcoming).not.toHaveBeenCalled();
    expect(recordSearch).not.toHaveBeenCalled();
    expect(resultLogs()).toEqual([]);
  });

  it("an island recovery reads its own source rather than a warmed anonymous partial page", async () => {
    const first = await app.request("/events", undefined, env);
    const firstHtml = await first.text();
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    expect(firstHtml).toContain("Local chess night 1");
    failed = false;
    vi.mocked(listUpcoming).mockResolvedValue({
      rows: [partialEvent(2)],
      hasMore: false,
      totalPages: 1,
      total: 1,
    });
    const next = await app.request(
      "/events",
      { headers: { "x-two-island": "events-calendar" } },
      env,
    );
    const nextHtml = await next.text();
    // Anonymous fragments remain public, but occupy a separate shared key.
    expect(next.headers.get("cache-control")).toBe("public, max-age=60");
    expect(next.headers.get("set-cookie")).toBeNull();
    expect(nextHtml).toContain("Local chess night 2");
    expect(nextHtml).not.toContain("Local chess night 1");
    expect(discordNotices(nextHtml)).toEqual([]);
    expect(discord.upcoming).toHaveBeenCalledTimes(2);
  });
});
