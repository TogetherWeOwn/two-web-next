import { describe, expect, it } from "vitest";
import { parseRecurrenceDate } from "../src/admin/recurrence-date";

// Pure unit fixtures: no store imports, DB, clock or timezone conversion.
describe("parseRecurrenceDate", () => {
  it("accepts a plain YYYY-MM-DD date at UTC midnight", () => {
    expect(parseRecurrenceDate("2026-10-11")?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
  });

  it.each(["T", " "])("accepts a legacy HH:mm carrier with separator %j", (separator) => {
    expect(parseRecurrenceDate(`2026-10-11${separator}09:30`)?.toISOString()).toBe(
      "2026-10-11T00:00:00.000Z",
    );
  });

  it.each(["T", " "])("accepts a legacy HH:mm:ss carrier with separator %j", (separator) => {
    expect(parseRecurrenceDate(`2026-10-11${separator}09:30:45`)?.toISOString()).toBe(
      "2026-10-11T00:00:00.000Z",
    );
  });

  it("never shifts the UTC date for a late-night stored time", () => {
    expect(parseRecurrenceDate("2026-10-11T23:59:59")?.toISOString()).toBe(
      "2026-10-11T00:00:00.000Z",
    );
    expect(parseRecurrenceDate("2026-10-11 23:59")?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
  });

  it.each(["2026-10-11T24:00", "2026-10-11T99:00", "2026-10-11 24:00:00"])(
    "rejects an out-of-range hour in %j",
    (carrier) => {
      expect(parseRecurrenceDate(carrier)).toBeNull();
    },
  );

  it.each(["2026-10-11T00:60", "2026-10-11T00:99", "2026-10-11 00:60:00"])(
    "rejects an out-of-range minute in %j",
    (carrier) => {
      expect(parseRecurrenceDate(carrier)).toBeNull();
    },
  );

  it.each(["2026-10-11T00:00:60", "2026-10-11T00:00:99", "2026-10-11 00:00:60"])(
    "rejects an out-of-range second in %j",
    (carrier) => {
      expect(parseRecurrenceDate(carrier)).toBeNull();
    },
  );

  it.each(["2024-02-29", "2000-02-29"])("accepts Feb 29 on leap year %j", (date) => {
    expect(parseRecurrenceDate(date)?.toISOString()).toBe(`${date}T00:00:00.000Z`);
  });

  it.each(["2023-02-29", "2025-02-29", "1900-02-29", "2026-02-29"])(
    "rejects Feb 29 on non-leap year %j",
    (date) => {
      expect(parseRecurrenceDate(date)).toBeNull();
    },
  );

  it.each(["2026-13-01", "2026-00-10", "2026-10-32", "2026-10-00", "2026-02-30", "2026-04-31"])(
    "rejects an impossible calendar date %j",
    (date) => {
      expect(parseRecurrenceDate(date)).toBeNull();
    },
  );

  it.each([
    "",
    "not-a-date",
    "10/11/2026",
    "2026-1-1",
    "2026-10-11T12",
    "2026-10-11 12:00:00.000",
    "2026-10-11T12:00Z",
    "2026-10-11T12:00:00+00:00",
    " 2026-10-11",
    "2026-10-11 ",
  ])("returns null for a non-matching string %j", (raw) => {
    expect(parseRecurrenceDate(raw)).toBeNull();
  });
});
