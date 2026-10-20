import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { listCalendarPast, listUpcoming, listUpcomingForMonth } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";

// Read seams remove external SQL only; the Hono route and shared screen stay
// real. The independent acceptance suite owns the populated-month and
// list-view cases; this file owns only the empty-month gap it does not cover.
vi.mock("../src/events/reads", async (original) => ({
  ...(await original<typeof import("../src/events/reads")>()),
  listUpcoming: vi.fn(),
  listUpcomingForMonth: vi.fn(),
  listCalendarPast: vi.fn(),
  persistedDiscordIds: vi.fn(async () => new Set<string>()),
}));

const db = {} as Db;
const discord = {
  upcoming: vi.fn(async () => []),
  lastReadFailed: () => true,
};
const env = { APP_URL: "https://calendar.example.test", ADMIN_DB: db, DISCORD_EVENTS: discord } as Env;
const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => null,
  async () => null,
);

function notices(html: string): string[] {
  return [...html.matchAll(/<(p|div|aside|section)\b[^>]*role="(?:status|alert)"[^>]*>([\s\S]*?)<\/\1>/g)]
    .map((match) => match[2]!)
    .filter((body) => /Discord[\s\S]*missing/i.test(body.replace(/<[^>]*>/g, " ")));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAnonEventCacheForTests();
  vi.mocked(listCalendarPast).mockResolvedValue([]);
});

describe("partial-source empty month", () => {
  it("warns on an empty month of a non-empty schedule instead of reading as definitively empty", async () => {
    // One local event lives outside the requested month, so the schedule is
    // non-empty (no empty state) while the rendered grid has no rows.
    vi.mocked(listUpcoming).mockResolvedValue({
      rows: [],
      hasMore: false,
      totalPages: 1,
      total: 1,
    });
    vi.mocked(listUpcomingForMonth).mockResolvedValue([]);
    const response = await app.request("/events?view=calendar&month=2099-05", undefined, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="events-calendar-grid"');
    expect(html).not.toContain('data-testid="events-empty-error"');
    expect(notices(html)).toHaveLength(1);
  });

  it("never claims rows are shown where an out-of-range page renders none", async () => {
    vi.mocked(listUpcoming).mockResolvedValue({ rows: [], hasMore: false, totalPages: 2, total: 25 });
    const response = await app.request("/events?q=chess&page=9", undefined, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="events-out-of-range"');
    const [notice] = notices(html);
    expect(notice).toBeDefined();
    expect(notice!.replace(/<[^>]*>/g, " ")).not.toMatch(/shown below|listed below/i);
  });
});
