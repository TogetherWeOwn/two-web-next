import { describe, expect, it } from "vitest";
import { formatEventWhen } from "../src/events/date-format";

describe("formatEventWhen", () => {
  it.each([
    [
      "America/New_York winter",
      new Date("2027-01-15T18:05:00Z"),
      "America/New_York",
      "Friday, 15 January 2027 at 13:05 GMT-05:00",
    ],
    [
      "America/New_York summer",
      new Date("2027-07-15T18:05:00Z"),
      "America/New_York",
      "Thursday, 15 July 2027 at 14:05 GMT-04:00",
    ],
    [
      "Asia/Kolkata fractional offset",
      new Date("2027-01-15T18:05:00Z"),
      "Asia/Kolkata",
      "Friday, 15 January 2027 at 23:35 GMT+05:30",
    ],
  ])("%s", (_name, date, timezone, expected) => {
    expect(formatEventWhen(date, timezone)).toBe(expected);
  });

  it("falls back to ISO for an invalid timezone", () => {
    const date = new Date("2027-01-15T18:05:00Z");
    expect(formatEventWhen(date, "Invalid/Timezone")).toBe(date.toISOString());
  });
});
