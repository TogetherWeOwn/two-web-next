// Week-start builder regressions: pure unit pins for the shared Monday/Sunday
// vocabulary, geometry selection and URL emission. Route behavior is covered
// by the acceptance contract (test/calendar-week-start-acceptance.test.ts).
import { describe, expect, it } from "vitest";
import {
  CALENDAR_DEFAULT_WEEK_START,
  CALENDAR_WEEK_START_PARAM,
  calendarGridRange,
  calendarJumpUrl,
  calendarUrl,
  monthGrid,
  resolveWeekStart,
  weekdayHeadings,
  WEEKDAY_HEADINGS,
  WEEKDAY_HEADINGS_SUNDAY,
  type CalendarState,
} from "../src/islands/contracts";

const state = (overrides: Partial<CalendarState> = {}): CalendarState => ({
  view: "calendar",
  month: "2027-02",
  q: "",
  game: "",
  past: false,
  page: 1,
  weekStart: "monday",
  ...overrides,
});

describe("week-start vocabulary", () => {
  it("defaults to Monday", () => {
    expect(CALENDAR_DEFAULT_WEEK_START).toBe("monday");
    expect(CALENDAR_WEEK_START_PARAM).toBe("weekStart");
  });

  it.each([["monday"], ["sunday"]])("resolves exactly one allowlisted value %s", (value) => {
    expect(resolveWeekStart([value])).toBe(value);
  });

  it.each([
    [[]],
    [[null]],
    [[undefined]],
    [[""]],
    [["Monday"]],
    [["sunday "]],
    [["sunday", "sunday"]],
    [["sunday", "monday"]],
  ])("normalizes %p to Monday", (values) => {
    expect(resolveWeekStart(values as unknown as string[])).toBe("monday");
  });

  it("resolves nullish input to Monday", () => {
    expect(resolveWeekStart(null)).toBe("monday");
    expect(resolveWeekStart(undefined)).toBe("monday");
  });
});

describe("week-start headings and geometry", () => {
  it("emits Monday headings by default and Sunday headings on request", () => {
    expect(weekdayHeadings("monday")).toEqual([...WEEKDAY_HEADINGS]);
    expect(weekdayHeadings("sunday")).toEqual([...WEEKDAY_HEADINGS_SUNDAY]);
    expect(weekdayHeadings("sunday")[0]).toBe("Sun");
  });

  it("keeps Monday geometry identical with an explicit default", () => {
    const implicit = monthGrid("2027-02", "2027-02-14", new Map()).flat();
    const explicit = monthGrid("2027-02", "2027-02-14", new Map(), "monday").flat();
    expect(explicit.map((day) => day.iso)).toEqual(implicit.map((day) => day.iso));
    expect(calendarGridRange("2027-02")).toEqual(calendarGridRange("2027-02", "monday"));
  });

  it("covers the Sunday grid's leading/trailing weeks in the read window", () => {
    expect(calendarGridRange("2027-02", "sunday")).toEqual({
      first: "2027-01-31",
      last: "2027-03-06",
    });
    expect(calendarGridRange("banana", "sunday")).toBeNull();
  });
});

describe("week-start URL emission", () => {
  it("omits the Monday default from shareable URLs", () => {
    expect(calendarUrl(state())).toBe("/events?view=calendar&month=2027-02");
    expect(calendarJumpUrl(false, "ev-1")).toBe("/events?event=ev-1#event-ev-1");
  });

  it("carries Sunday on calendar, list and day-jump URLs", () => {
    expect(calendarUrl(state({ weekStart: "sunday" }))).toBe(
      "/events?weekStart=sunday&view=calendar&month=2027-02",
    );
    expect(calendarUrl(state({ view: "list", weekStart: "sunday" }))).toBe(
      "/events?weekStart=sunday",
    );
    expect(calendarJumpUrl(true, "ev-1", "Chess", "sunday")).toBe(
      "/events?event=ev-1&past=1&game=Chess&weekStart=sunday#event-ev-1",
    );
  });
});
