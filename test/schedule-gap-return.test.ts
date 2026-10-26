// Builder-owned: gap preview links must not silently lose their schedule origin.
import { describe, expect, it } from "vitest";
import { jsx } from "hono/jsx/jsx-runtime";
import { EventsCalendarPage } from "../src/events/pages-calendar-screen";
import { linksIn } from "./helpers/past-archive-search-acceptance";
import { scheduleRow } from "./helpers/schedule-detail-return-acceptance";

describe("schedule gap return", () => {
  it("carries the effective schedule origin on the native past preview link", async () => {
    const html = await jsx(EventsCalendarPage, {
      state: { view: "list", month: "2031-01", q: "", past: false, page: 1 },
      upcoming: [],
      past: [scheduleRow(41, { status: "past" })],
      zone: "UTC",
      now: new Date("2030-06-15T12:00:00Z"),
      totalPages: 0,
      emptyState: "gap",
      discordFailed: false,
      games: [],
      gameFilter: null,
      member: false,
      inviteUrl: "/discord",
      appUrl: "https://example.test",
    }).toString();
    const event = linksIn(html).find((link) => link.url.pathname.startsWith("/e/"));
    expect(event).toBeDefined();
    expect(Object.fromEntries(event!.url.searchParams)).toEqual({ schedulePage: "1" });
  });
});
