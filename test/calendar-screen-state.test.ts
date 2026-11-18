// Derived display state for the events calendar screen: pure, offline, no DB.
import { describe, expect, it } from "vitest";
import {
  deriveCalendarScreenState,
  type CalendarScreenStateInput,
} from "../src/events/calendar-screen-state";
import type { CalendarState } from "../src/islands/contracts";
import { gathering } from "./helpers/calendar-multiday-acceptance";

const listState: CalendarState = { view: "list", month: "2030-06", q: "", past: false, page: 1 };
const calState: CalendarState = { ...listState, view: "calendar" };

const input = (overrides: Partial<CalendarScreenStateInput> = {}): CalendarScreenStateInput => ({
  state: listState,
  upcoming: [],
  past: [],
  pastMayBeTruncated: false,
  zone: "UTC",
  now: new Date("2030-06-10T12:00:00Z"),
  totalPages: 0,
  emptyState: null,
  discordFailed: false,
  gameFilter: null,
  ...overrides,
});

const event = (startsAt: string, endsAt: string) =>
  gathering({ startsAt: new Date(startsAt), endsAt: new Date(endsAt), timezone: "UTC" });

const cell = (weeks: ReturnType<typeof deriveCalendarScreenState>["weeks"], iso: string) =>
  weeks.flat().find((d) => d.iso === iso)!;

describe("deriveCalendarScreenState", () => {
  it("treats a blank query as no search and a real query as search plus open past", () => {
    const blank = deriveCalendarScreenState(input({ state: { ...listState, q: "   " } }));
    expect(blank.searching).toBe(false);
    expect(blank.showPast).toBe(false);
    const q = deriveCalendarScreenState(input({ state: { ...listState, q: " chess " } }));
    expect(q.searching).toBe(true);
    expect(q.showPast).toBe(true);
  });

  it("counts past rows as visible only while the drawer is showing", () => {
    const past = [event("2030-05-01T10:00:00Z", "2030-05-01T11:00:00Z")];
    expect(deriveCalendarScreenState(input({ past })).hasVisibleResults).toBe(false);
    expect(
      deriveCalendarScreenState(input({ past, state: { ...listState, past: true } }))
        .hasVisibleResults,
    ).toBe(true);
  });

  it("flags a page past the end as out of range, never a search miss", () => {
    const s = deriveCalendarScreenState(
      input({ state: { ...listState, q: "chess", page: 3 }, totalPages: 2 }),
    );
    expect(s.outOfRange).toBe(true);
    expect(s.searchMiss).toBe(false);
  });

  it("reports a search miss, suppressed by an error state or failed source", () => {
    const q = { ...listState, q: "chess" };
    expect(deriveCalendarScreenState(input({ state: q })).searchMiss).toBe(true);
    expect(deriveCalendarScreenState(input({ state: q, emptyState: "error" })).searchMiss).toBe(
      false,
    );
    expect(deriveCalendarScreenState(input({ state: q, discordFailed: true })).searchMiss).toBe(
      false,
    );
  });

  it("reports a game-scoped miss only when unsearched with no pages", () => {
    expect(deriveCalendarScreenState(input({ gameFilter: "Chess" })).searchMiss).toBe(true);
    expect(deriveCalendarScreenState(input()).searchMiss).toBe(false);
    expect(
      deriveCalendarScreenState(input({ gameFilter: "Chess", totalPages: 1 })).searchMiss,
    ).toBe(false);
  });

  it("plots a canonical multi-day row on every touched day and past rows on their start day", () => {
    const multi = event("2030-06-01T22:00:00Z", "2030-06-03T10:00:00Z");
    const past = event("2030-06-05T09:00:00Z", "2030-06-05T10:00:00Z");
    const open = deriveCalendarScreenState(
      input({ state: { ...calState, past: true }, upcoming: [multi], past: [past] }),
    );
    for (const iso of ["2030-06-01", "2030-06-02", "2030-06-03"]) {
      expect(cell(open.weeks, iso).events).toEqual([multi]);
    }
    expect(cell(open.weeks, "2030-06-04").events).toEqual([]);
    expect(cell(open.weeks, "2030-06-05").events).toEqual([past]);
    expect(cell(open.weeks, "2030-06-10").isToday).toBe(true);
    // Drawer closed: past rows are not plotted.
    const closed = deriveCalendarScreenState(
      input({ state: calState, upcoming: [multi], past: [past] }),
    );
    expect(cell(closed.weeks, "2030-06-05").events).toEqual([]);
  });

  it("derives month emptiness from in-month rows, source health and truncation", () => {
    const empty = (o: Partial<CalendarScreenStateInput> = {}) =>
      deriveCalendarScreenState(input({ state: calState, ...o })).monthEmpty;
    expect(empty()).toBe(true);
    expect(deriveCalendarScreenState(input()).monthEmpty).toBe(false); // list view
    expect(empty({ discordFailed: true })).toBe(false);
    expect(empty({ emptyState: "gap" })).toBe(false);
    expect(empty({ gameFilter: "Chess" })).toBe(false); // search miss wins
    expect(empty({ upcoming: [event("2030-06-20T10:00:00Z", "2030-06-20T11:00:00Z")] })).toBe(
      false,
    );
    // Closed drawer still counts an in-month past start-day.
    expect(empty({ past: [event("2030-06-03T10:00:00Z", "2030-06-03T11:00:00Z")] })).toBe(false);
    // A spillover-only row does not occupy the month.
    expect(empty({ upcoming: [event("2030-05-31T10:00:00Z", "2030-05-31T11:00:00Z")] })).toBe(true);
    // A capped read doesn't prove absence, even when it plots no rows.
    expect(empty({ upcomingMonthMayBeTruncated: true })).toBe(false);
    expect(empty({ pastMayBeTruncated: true })).toBe(false);
    const july = { ...calState, month: "2030-07" };
    // With no retained starts, the truncated drawer doesn't bound unseen rows.
    expect(empty({ pastMayBeTruncated: true, state: july })).toBe(false);
    const past = [event("2030-06-03T10:00:00Z", "2030-06-03T11:00:00Z")];
    expect(empty({ pastMayBeTruncated: true, state: july, past })).toBe(true);
  });
});
