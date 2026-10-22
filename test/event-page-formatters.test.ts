import { describe, expect, it } from "vitest";
import {
  cardTimeLabel,
  isEditedEvent,
  updatedStampLabel,
  wallDateIso,
  wallTimeHm,
} from "../src/events/date-format";

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

describe("edited-event stamp label", () => {
  const updated = new Date("2029-11-20T15:30:00.000Z");

  it.each([
    ["UTC", "Tuesday, 20 November 2029 at 15:30 GMT+00:00"],
    ["Pacific/Auckland", "Wednesday, 21 November 2029 at 04:30 GMT+13:00"],
    ["not/a-zone", "2029-11-20T15:30:00.000Z"],
  ])("formats the complete edit date in %s", (zone, expected) => {
    expect(updatedStampLabel(updated, zone)).toBe(expected);
  });
});

describe("edited-event stamp predicate", () => {
  const created = new Date("2028-05-01T12:00:00.000Z");

  it("treats only edits strictly past 60 seconds as edited", () => {
    expect(isEditedEvent(created, new Date(created.getTime() + 60_001))).toBe(true);
    expect(isEditedEvent(created, created)).toBe(false);
    expect(isEditedEvent(created, new Date(created.getTime() + 59_999))).toBe(false);
    expect(isEditedEvent(created, new Date(created.getTime() + 60_000))).toBe(false);
    expect(isEditedEvent(created, new Date(created.getTime() - 1))).toBe(false);
  });

  it("reads missing or unparseable instants as unedited instead of throwing", () => {
    const updated = new Date("2029-11-20T15:30:00.000Z");
    expect(isEditedEvent(undefined, undefined)).toBe(false);
    expect(isEditedEvent(null, updated)).toBe(false);
    expect(isEditedEvent(created, null)).toBe(false);
    expect(isEditedEvent(new Date(Number.NaN), updated)).toBe(false);
    expect(isEditedEvent(created, new Date(Number.NaN))).toBe(false);
  });
});
