// Builder-owned edge cases complement the immutable route/browser acceptance.
// Break caught: a safe page number with an unsafe schedule offset must not
// produce a return URL that normalizes to a different page.
import { describe, expect, it } from "vitest";
import { scheduleContext, withoutScheduleContext } from "../src/events/schedule-context";

describe("schedule context bounds", () => {
  it("rejects safe integers whose upcoming-list offset is unsafe", () => {
    expect(scheduleContext("?schedulePage=9007199254740991")).toBeNull();
  });

  it.each([
    "schedulePage=1&schedulePast=0",
    "schedulePage=1&schedulePast=1&schedulePast=1",
    "schedulePage=1&scheduleMonth=2031-01",
    "schedulePage=2&scheduleView=calendar&scheduleMonth=2031-01",
    "schedulePage=1&scheduleView=calendar&scheduleMonth=2031-1",
    "schedulePage=1&scheduleView=calendar&scheduleMonth=2031-01&scheduleQuery=Chess",
    "schedulePage=1&scheduleQuery=%00",
    "schedulePage=1&scheduleGame=%0AChess",
    `schedulePage=1&scheduleGame=${"x".repeat(256)}`,
    `schedulePage=1&ignored=${"x".repeat(4096)}`,
  ])("refuses malformed structured envelope %s", (query) => {
    expect(scheduleContext(`?${query}`)).toBeNull();
  });

  it("removes only presentation fields from an existing OAuth journey", () => {
    expect(
      withoutScheduleContext(
        "?attendees=2&archivePage=3&schedulePage=1&schedulePage=2&scheduleQuery=Chess",
      ),
    ).toBe("?attendees=2&archivePage=3");
    expect(withoutScheduleContext("?schedulePage=1")).toBe("");
    expect(withoutScheduleContext("?q=a%20b")).toBe("?q=a%20b");
  });
});
