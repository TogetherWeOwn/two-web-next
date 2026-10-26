import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { loadCalendarPageModel, resolveCalendarInput } from "../src/events/page-models.server";
import { listCalendarPast, listUpcoming, listUpcomingForMonth } from "../src/events/reads";
import { discordScheduleEvent } from "./helpers/calendar-cancellation";

// Read seams remove external SQL only; the model stays real. These
// implementation-owned cases pin the Sunday grid's Discord-transient window:
// a transient on a Sunday-only leading day must plot on the Sunday grid and
// stay out of the Monday grid. The independent acceptance suite stubs the
// Discord source as empty, so it cannot see this filter.
vi.mock("../src/events/reads", async (original) => ({
  ...(await original<typeof import("../src/events/reads")>()),
  listUpcoming: vi.fn(),
  listUpcomingForMonth: vi.fn(),
  listCalendarPast: vi.fn(),
  listPublishedGames: vi.fn(async () => []),
  persistedDiscordIds: vi.fn(async () => new Set<string>()),
}));

const db = {} as Db;
// February 2027 opens on a Monday, so the Sunday grid alone covers the
// leading Sunday 2027-01-31; `now` precedes the transient, so it stays upcoming.
const transient = () => ({
  ...discordScheduleEvent(),
  startsAt: new Date("2027-01-31T20:00:00Z"),
  endsAt: new Date("2027-01-31T22:00:00Z"),
});
const discord = {
  upcoming: vi.fn(async () => [transient()]),
  lastReadFailed: () => false,
};
const now = new Date("2027-01-20T12:00:00Z");

async function upcomingIds(
  query: Record<string, string | readonly string[]>,
): Promise<(string | number)[]> {
  const model = await loadCalendarPageModel({
    db,
    input: resolveCalendarInput(query),
    includeDrafts: false,
    discord,
    now,
  });
  return model.upcoming.map((row) => ("discordId" in row ? row.discordId : row.id));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAnonEventCacheForTests();
  vi.mocked(listUpcoming).mockResolvedValue({ rows: [], hasMore: false, totalPages: 1, total: 0 });
  vi.mocked(listUpcomingForMonth).mockResolvedValue([]);
  vi.mocked(listCalendarPast).mockResolvedValue([]);
});

describe("week-start transient window", () => {
  it("plots a Sunday-only leading-day transient on the Sunday grid", async () => {
    expect(
      await upcomingIds({ view: "calendar", month: "2027-02", weekStart: ["sunday"] }),
    ).toEqual(["123456789012345678"]);
  });

  it("keeps the Sunday-only transient out of the Monday grid", async () => {
    expect(await upcomingIds({ view: "calendar", month: "2027-02" })).toEqual([]);
    expect(
      await upcomingIds({ view: "calendar", month: "2027-02", weekStart: ["monday"] }),
    ).toEqual([]);
  });
});
