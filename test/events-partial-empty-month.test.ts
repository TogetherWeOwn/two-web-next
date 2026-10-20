import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";
import { listCalendarPast, listUpcoming, listUpcomingForMonth } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import { partialEvent, partialHtml } from "./helpers/calendar-discord-partial";

// Read seams remove external SQL only; the model, Hono route and Kit screen
// stay real. These implementation-owned cases supplement the independent
// acceptance suite with empty-month and failed-empty precedence coverage.
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
const env = {
  APP_URL: "https://calendar.example.test",
  ADMIN_DB: db,
  DISCORD_EVENTS: discord,
} as unknown as Env;
const app = new Hono<{ Bindings: Env }>();
registerEventRoutes(
  app,
  async () => null,
  async () => null,
);

function notices(html: string): string[] {
  return [
    ...html.matchAll(/<(p|div|aside|section)\b[^>]*role="(?:status|alert)"[^>]*>([\s\S]*?)<\/\1>/g),
  ]
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
    vi.mocked(listUpcoming).mockResolvedValue({
      rows: [],
      hasMore: false,
      totalPages: 2,
      total: 25,
    });
    const response = await app.request("/events?q=chess&page=9", undefined, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="events-out-of-range"');
    const [notice] = notices(html);
    expect(notice).toBeDefined();
    expect(notice!.replace(/<[^>]*>/g, " ")).not.toMatch(/shown below|listed below/i);
  });
});

describe("failed-empty notice precedence", () => {
  for (const adapter of ["Hono", "Kit"] as const) {
    it.each(["empty calendar", "past-only search"] as const)(
      `${adapter} renders only the full error for a failed %s`,
      async (scenario) => {
        vi.mocked(listUpcoming).mockResolvedValue({
          rows: [],
          hasMore: false,
          totalPages: 0,
          total: 0,
        });
        vi.mocked(listUpcomingForMonth).mockResolvedValue([]);
        const input: Record<string, string> =
          scenario === "empty calendar"
            ? { view: "calendar", month: "2099-05" }
            : { q: "chess", past: "1" };
        if (scenario === "past-only search") {
          vi.mocked(listCalendarPast).mockResolvedValue([
            {
              ...partialEvent(2),
              startsAt: new Date("2020-01-01T20:00:00Z"),
              endsAt: new Date("2020-01-01T22:00:00Z"),
            },
          ]);
        }

        let html: string;
        if (adapter === "Kit") {
          const model = await loadCalendarPageModel({
            db,
            input: resolveCalendarInput(input),
            includeDrafts: false,
            discord,
            now: new Date("2099-05-01T12:00:00Z"),
          });
          html = await partialHtml(model);
        } else {
          const response = await app.request(
            `/events?${new URLSearchParams(input)}`,
            undefined,
            env,
          );
          expect(response.status).toBe(200);
          html = await response.text();
        }

        // Dropping the empty-state guard renders a partial notice as well as
        // the full error in both cases, duplicating the retry and join actions.
        expect(html.match(/data-testid="events-empty-error"/g)).toHaveLength(1);
        expect(notices(html)).toHaveLength(0);
        expect(html).not.toContain('data-testid="events-partial-source"');
        expect(html.match(/data-testid="events-retry"/g)).toHaveLength(1);
        expect(html.match(/data-testid="discord-join"/g)).toHaveLength(1);
        expect(html).not.toContain('data-testid="events-empty-search"');
      },
    );
  }
});
