import { describe, expect, it } from "vitest";
import { cardTimeLabel, wallDateIso, wallTimeHm } from "../src/events/date-format";

describe("server event date formatters", () => {
  it("serializes an instant using its host timezone without mutating the date", () => {
    const startsAt = new Date("2026-10-11T23:45:00.000Z");

    expect(wallDateIso(startsAt, "Pacific/Auckland")).toBe("2026-10-12");
    expect(wallTimeHm(startsAt, "Pacific/Auckland")).toBe("12:45");
    expect(cardTimeLabel(startsAt, "Pacific/Auckland")).toBe("Mon 12 Oct, 12:45");
    expect(startsAt.toISOString()).toBe("2026-10-11T23:45:00.000Z");
  });

  it("uses UTC for invalid zones", () => {
    expect(wallDateIso(new Date("2026-10-11T23:45:00.000Z"), "not/a-zone")).toBe("2026-10-11");
  });
});
