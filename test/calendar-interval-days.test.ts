// Builder-owned edge coverage for the multi-day interval helpers: degenerate
// windows, unusable bounds and label fallbacks. Day-membership behavior is
// pinned by the acceptance suites; these cases only guard the total-function
// fallbacks. DB-free.
import { describe, expect, it } from "vitest";
import { calendarDayLongLabel, canonicalIntervalDays } from "../src/events/date-format";
import { gridContinuationAccessibleName } from "../src/islands/contracts";

const GRID_FIRST = "2027-02-01";
const GRID_LAST = "2027-02-28";

describe("canonicalIntervalDays fallbacks", () => {
  it("keeps start-day plotting for a degenerate window inside the grid", () => {
    const at = new Date("2027-02-14T12:00:00Z");
    expect(canonicalIntervalDays(at, at, "UTC", GRID_FIRST, GRID_LAST)).toEqual(["2027-02-14"]);
    expect(
      canonicalIntervalDays(
        new Date("2027-02-14T12:00:00Z"),
        new Date("2027-02-14T11:00:00Z"),
        "UTC",
        GRID_FIRST,
        GRID_LAST,
      ),
    ).toEqual(["2027-02-14"]);
  });

  it("drops a degenerate window whose start day is outside the grid", () => {
    const at = new Date("2027-03-05T12:00:00Z");
    expect(canonicalIntervalDays(at, at, "UTC", GRID_FIRST, GRID_LAST)).toEqual([]);
  });

  it("returns no days when the grid bounds are unusable", () => {
    const start = new Date("2027-02-14T23:30:00Z");
    const end = new Date("2027-02-15T01:00:00Z");
    expect(canonicalIntervalDays(start, end, "UTC", "banana", GRID_LAST)).toEqual([]);
    expect(canonicalIntervalDays(start, end, "UTC", GRID_FIRST, "banana")).toEqual([]);
  });

  it("clips an end-exclusive midnight at the grid edge to nothing", () => {
    expect(
      canonicalIntervalDays(
        new Date("2027-01-20T12:00:00Z"),
        new Date("2027-02-01T00:00:00Z"),
        "UTC",
        GRID_FIRST,
        GRID_LAST,
      ),
    ).toEqual([]);
  });
});

describe("continuation naming fallbacks", () => {
  it("names the displayed day in long form", () => {
    expect(gridContinuationAccessibleName("Multi-day gathering", "2027-02-15")).toBe(
      "Continues Multi-day gathering, Monday, 15 February 2027",
    );
  });

  it("falls back to the raw day instead of throwing", () => {
    expect(calendarDayLongLabel("banana")).toBe("banana");
    expect(gridContinuationAccessibleName("Title", "banana")).toBe("Continues Title, banana");
  });
});
