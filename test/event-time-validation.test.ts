// W15 acceptance port: legacy tests/Feature/Events/EventTimezoneTest.php,
// EventCapacityFloorTest.php (form floor) and the fold-carrier rule (TOG-6805)
// as pure functions against src/admin/validation.ts. Hermetic — no database.
import { describe, expect, it } from "vitest";
import { ValidationError, nextStatus, parseEventForm, utcToWall, wallToUtc } from "../src/admin/validation";

// Europe/London 2026: BST runs 2026-03-29 01:00Z → 2026-10-25 01:00Z.
const errors = (fn: () => unknown): Record<string, string> => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.fields;
    throw e;
  }
  throw new Error("expected a ValidationError");
};

describe("wall time → UTC (legacy EventTimezoneTest)", () => {
  it("stores the correct UTC instant for a local wall time on both sides of a DST boundary", () => {
    expect(wallToUtc("2026-07-15 20:00", "Europe/London").toISOString()).toBe("2026-07-15T19:00:00.000Z"); // BST
    expect(wallToUtc("2026-01-15 20:00", "Europe/London").toISOString()).toBe("2026-01-15T20:00:00.000Z"); // GMT
  });

  it("renders back as 20:00 in the event's own zone on both sides of a DST boundary", () => {
    expect(utcToWall(new Date("2026-07-15T19:00:00Z"), "Europe/London")).toBe("2026-07-15 20:00");
    expect(utcToWall(new Date("2026-01-15T20:00:00Z"), "Europe/London")).toBe("2026-01-15 20:00");
  });

  it("accepts the same wall instant in a zone with no transition", () => {
    expect(wallToUtc("2026-07-15 20:00", "UTC").toISOString()).toBe("2026-07-15T20:00:00.000Z");
  });

  it("rejects a timezone that is not an IANA identifier", () => {
    expect(errors(() => wallToUtc("2026-07-15 20:00", "Mars/Olympus"))).toMatchObject({
      timezone: "Unknown timezone: Mars/Olympus",
    });
  });

  it("rejects a wall time that carries its own offset (the parser only accepts naive input)", () => {
    // TOG-6804: an offset-bearing string would silently win over the explicit zone.
    expect(errors(() => wallToUtc("2026-07-15T20:00:00+02:00", "Europe/London"))).toMatchObject({
      wall: expect.stringContaining("Not a date and time"),
    });
    expect(errors(() => wallToUtc("2026-07-15 20:00 +01:00", "Europe/London"))).toMatchObject({
      wall: expect.stringContaining("Not a date and time"),
    });
  });

  it("rejects a wall time that never occurred in the spring-forward gap and names the zone", () => {
    // 2026-03-29 01:00 GMT → 02:00 BST: local 01:00–01:59 never happened.
    expect(errors(() => wallToUtc("2026-03-29 01:30", "Europe/London"))).toMatchObject({
      wall: "That time never occurred in Europe/London — clocks skipped forward over it. Pick a time outside the gap.",
    });
  });

  it("accepts the gap shoulders", () => {
    expect(wallToUtc("2026-03-29 00:59", "Europe/London").toISOString()).toBe("2026-03-29T00:59:00.000Z");
    expect(wallToUtc("2026-03-29 02:00", "Europe/London").toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });

  it("resolves an autumn fold to the second (GMT) occurrence like legacy", () => {
    // Legacy EventTimezoneTest pins 2026-10-25 01:30 -> 01:30:00 UTC (TOG-11669).
    expect(wallToUtc("2026-10-25 01:30", "Europe/London").toISOString()).toBe("2026-10-25T01:30:00.000Z");
  });

  it("rejects impossible calendar dates instead of rolling them over", () => {
    expect(errors(() => wallToUtc("2026-02-30 20:00", "Europe/London"))).toMatchObject({
      wall: expect.stringContaining("Not a date and time"),
    });
  });
});

describe("event form floor (legacy EventCapacityFloorTest, form rules)", () => {
  const form = (capacity: unknown) =>
    parseEventForm({
      title: "Game night",
      starts_at: "2026-07-15 20:00",
      ends_at: "2026-07-15 22:00",
      timezone: "Europe/London",
      ...(capacity === undefined ? {} : { capacity }),
    });

  it("accepts the headcount floor, a larger room, and an empty (unlimited) capacity", () => {
    expect(form("1").capacity).toBe(1);
    expect(form("8").capacity).toBe(8);
    expect(form("2147483647").capacity).toBe(2147483647);
    expect(form("").capacity).toBeNull();
    expect(form(undefined).capacity).toBeNull();
  });

  it("refuses zero, negatives, non-numeric headcounts, and Postgres integer overflow", () => {
    for (const bad of ["0", "-3", "3.5", "eight", "1e2", "2147483648"]) {
      expect(errors(() => form(bad))).toMatchObject({
        capacity: "Capacity is a headcount from 1 to 2147483647, or empty for unlimited.",
      });
    }
  });

  it("rejects an offset-bearing wall time at the form edge", () => {
    expect(
      errors(() =>
        parseEventForm({
          title: "Game night",
          starts_at: "2026-07-15T20:00:00+02:00",
          ends_at: "2026-07-15 22:00",
          timezone: "Europe/London",
        }),
      ),
    ).toEqual({ starts_at: "Not a date and time (want YYYY-MM-DD HH:mm): 2026-07-15T20:00:00+02:00" });
  });

  it("keeps the exact stored instant for unchanged fold-ambiguous wall text (TOG-6805 carrier)", () => {
    const wall = "2026-10-25 01:30";
    const form = (carrier?: string) =>
      parseEventForm({ title: "T", starts_at: wall, ends_at: "2026-10-25 03:00", timezone: "Europe/London" }, carrier === undefined ? undefined : { startsAtUtc: carrier });
    // The carrier rides in the edit page's hidden *_utc field, and either side of
    // the fold survives an unchanged resubmit.
    expect(form("2026-10-25T01:30:00.000Z").startsAtUtc.toISOString()).toBe("2026-10-25T01:30:00.000Z"); // GMT side
    expect(form("2026-10-25T00:30:00.000Z").startsAtUtc.toISOString()).toBe("2026-10-25T00:30:00.000Z"); // BST side
    // Without a carrier (create) the fresh parse takes the second, GMT occurrence.
    expect(form().startsAtUtc.toISOString()).toBe("2026-10-25T01:30:00.000Z");
  });
});

describe("status transition guard (legacy EventService::transitionTo)", () => {
  it("lets drafts publish and drafts/published cancel", () => {
    expect(nextStatus("draft", "published")).toBe("published");
    expect(nextStatus("draft", "cancelled")).toBe("cancelled");
    expect(nextStatus("published", "cancelled")).toBe("cancelled");
  });

  it("refuses re-publishing and archiving a published event", () => {
    expect(errors(() => nextStatus("published", "published"))).toMatchObject({ status: "Only a draft can be published." });
    expect(errors(() => nextStatus("past", "published"))).toMatchObject({ status: "Only a draft can be published." });
  });

  it("refuses cancelling a past event and keeps cancelled terminal", () => {
    expect(errors(() => nextStatus("past", "cancelled"))).toMatchObject({
      status: "Only a draft or a published event can be cancelled.",
    });
    expect(errors(() => nextStatus("cancelled", "published"))).toMatchObject({
      status: "A cancelled event stays cancelled — Discord was already told.",
    });
    expect(errors(() => nextStatus("cancelled", "cancelled"))).toMatchObject({
      status: "A cancelled event stays cancelled — Discord was already told.",
    });
  });
});
