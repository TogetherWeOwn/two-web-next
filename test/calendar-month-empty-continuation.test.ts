// Builder-owned month-empty regressions: the claim must agree with the
// shared grid's occupied host days, not just the original start month.
import { describe, expect, it } from "vitest";
import type { DiscordTransient } from "../src/islands/contracts";
import { calendarLinks, gathering, renderCalendar } from "./helpers/calendar-multiday-acceptance";

const cases = [
  {
    name: "a gathering starting before the grid continues into the selected month",
    month: "2027-02",
    start: "2027-01-20T23:30:00Z",
    end: "2027-02-03T00:00:00Z",
    zone: "UTC",
    days: ["2027-02-01", "2027-02-02"],
    empty: false,
  },
  {
    name: "an ongoing gathering started last year in the current month",
    month: "2027-01",
    start: "2026-12-31T23:30:00Z",
    end: "2027-01-20T00:00:00Z",
    zone: "UTC",
    days: [
      "2026-12-31",
      ...Array.from({ length: 19 }, (_, i) => `2027-01-${String(i + 1).padStart(2, "0")}`),
    ],
    empty: false,
  },
  {
    name: "a gathering occupies leading spillover days only",
    month: "2027-05",
    start: "2027-04-28T23:30:00Z",
    end: "2027-04-30T00:00:00Z",
    zone: "UTC",
    days: ["2027-04-28", "2027-04-29"],
    empty: true,
  },
  {
    name: "an exclusive midnight end does not occupy the selected month",
    month: "2027-05",
    start: "2027-04-30T23:30:00Z",
    end: "2027-05-01T00:00:00Z",
    zone: "UTC",
    days: ["2027-04-30"],
    empty: true,
  },
  {
    name: "a gathering occupies trailing spillover days only",
    month: "2027-05",
    start: "2027-06-01T23:30:00Z",
    end: "2027-06-03T00:00:00Z",
    zone: "UTC",
    days: ["2027-06-01", "2027-06-02"],
    empty: true,
  },
  {
    name: "host midnight excludes February despite UTC and viewer February dates",
    month: "2027-02",
    start: "2027-02-01T04:30:00Z",
    end: "2027-02-01T05:00:00Z",
    zone: "America/New_York",
    days: [],
    empty: true,
  },
  {
    name: "a host-zone continuation occupies February despite its January start",
    month: "2027-02",
    start: "2027-02-01T04:30:00Z",
    end: "2027-02-01T05:30:00Z",
    zone: "America/New_York",
    days: ["2027-02-01"],
    empty: false,
  },
];

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin}: month-empty continuation membership`, () => {
    it.each(cases)("$name", async ({ month, start, end, zone, days, empty }) => {
      const html = await renderCalendar(
        twin,
        [gathering({ startsAt: new Date(start), endsAt: new Date(end), timezone: zone })],
        { month, zone: "Asia/Tokyo" },
      );
      expect(calendarLinks(html).map((link) => link.day)).toEqual(days);
      expect(html.includes('data-testid="calendar-month-empty"')).toBe(empty);
    });

    it("does not infer continuation days from a Discord transient's end", async () => {
      const transient: DiscordTransient = {
        discordId: "discord-only",
        status: "active",
        title: "Discord transient",
        description: null,
        location: null,
        startsAt: new Date("2027-04-30T23:30:00Z"),
        endsAt: new Date("2027-05-02T01:00:00Z"),
      };
      const html = await renderCalendar(twin, [transient], { month: "2027-05" });
      expect(calendarLinks(html).map((link) => link.day)).toEqual(["2027-04-30"]);
      expect(html).toContain('data-testid="calendar-month-empty"');
    });
  });
}
