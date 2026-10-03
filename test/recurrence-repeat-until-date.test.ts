import { describe, expect, it } from "vitest";
import { MAX_OCCURRENCES, parseRecurrenceForm } from "../src/admin/recurrence";
import { ValidationError } from "../src/admin/validation";

const fieldsOf = (data: Record<string, unknown>) => {
  try {
    parseRecurrenceForm(data);
  } catch (e) {
    if (e instanceof ValidationError) return e.fields;
    throw e;
  }
  return null;
};

const weekly = { recurrence_frequency: "weekly" };
const invalidDate = { recurrence_ends_on: "The repeat-until date is not a date." };

// Pure form fixtures: no store imports, DB, clock or timezone conversion.
describe("repeat-until date carriers", () => {
  it("refuses an impossible legacy datetime with the repeat-until field error", () => {
    expect(fieldsOf({ ...weekly, recurrence_ends_on: "2026-10-11T99:99:99" })).toEqual(invalidDate);
  });

  it.each(["T", " "])("validates each optional time part with separator %j", (separator) => {
    for (const time of [
      "24:00",
      "99:00",
      "00:60",
      "00:99",
      "24:00:00",
      "00:60:00",
      "00:00:60",
      "00:00:99",
    ]) {
      const carrier = `2026-10-11${separator}${time}`;
      expect(fieldsOf({ ...weekly, recurrence_ends_on: carrier }), carrier).toEqual(invalidDate);
      // A valid count must not hide a malformed repeat-until date.
      expect(
        fieldsOf({ ...weekly, recurrence_count: "4", recurrence_ends_on: carrier }),
        carrier,
      ).toEqual(invalidDate);
    }
  });

  it.each([
    "2026-10-11T",
    "2026-10-11T12",
    "2026-10-11T12:",
    "2026-10-11T12:00:",
    "2026-10-11T1:00",
    "2026-10-11T12:0",
    "2026-10-11T12:00:0",
    "2026-10-11T-1:00",
    "2026-10-11T12:00:00:00",
    "2026-10-11T12:00.5",
    "2026-10-11T12:00:00.000",
    "2026-10-11T12:00Z",
    "2026-10-11T12:00:00Z",
    "2026-10-11T12:00+01:00",
    "2026-10-11t12:00",
    "2026-10-11  12:00",
    "2026-10-11\t12:00",
    "2026-10-11T12:00garbage",
  ])("does not widen the timestamp grammar for %j", (carrier) => {
    expect(fieldsOf({ ...weekly, recurrence_ends_on: carrier })).toEqual(invalidDate);
  });

  it.each([
    "2026-02-29",
    "1900-02-29",
    "2026-04-31",
    "2026-00-11",
    "2026-13-11",
    "2026-10-00",
    "2026-10-32",
    "2026-2-01",
    "2026-02-1",
    "2026/10/11",
    "soon",
  ])("still refuses invalid calendar dates %j, including valid-time carriers", (date) => {
    for (const suffix of ["", "T23:59:59", " 00:00"]) {
      expect(fieldsOf({ ...weekly, recurrence_ends_on: date + suffix })).toEqual(invalidDate);
    }
  });

  it.each(["2026-10-11", "2028-02-29", "2000-02-29"])(
    "accepts %s and supported legacy carriers as UTC midnight",
    (date) => {
      for (const suffix of [
        "",
        "T00:00",
        " 00:00",
        "T23:59",
        " 23:59",
        "T00:00:00",
        " 00:00:00",
        "T23:59:59",
        " 23:59:59",
      ]) {
        const carrier = date + suffix;
        const rule = parseRecurrenceForm({ ...weekly, recurrence_ends_on: carrier });
        expect(rule, carrier).toEqual({
          frequency: "weekly",
          count: null,
          endsOn: new Date(`${date}T00:00:00.000Z`),
        });
      }
    },
  );

  it("preserves whitespace trimming, blank ends-on and integer count compatibility", () => {
    expect(
      parseRecurrenceForm({
        ...weekly,
        recurrence_ends_on: " \n2026-10-11T23:59:59\t ",
        recurrence_count: " 4 ",
      }),
    ).toEqual({
      frequency: "weekly",
      count: 4,
      endsOn: new Date("2026-10-11T00:00:00.000Z"),
    });
    for (const count of [1, 4, MAX_OCCURRENCES]) {
      expect(
        parseRecurrenceForm({
          ...weekly,
          recurrence_count: String(count),
          recurrence_ends_on: " \t ",
        }),
      ).toEqual({
        frequency: "weekly",
        count,
        endsOn: null,
      });
    }
    expect(fieldsOf({ ...weekly, recurrence_ends_on: " " })).toEqual({
      recurrence_count: "Give a number of occurrences or a repeat-until date.",
    });
  });

  it("ignores stale recurrence inputs on one-off forms", () => {
    expect(
      parseRecurrenceForm({ recurrence_ends_on: "2026-10-11T99:99:99", recurrence_count: "4" }),
    ).toBeNull();
    expect(
      parseRecurrenceForm({ recurrence_frequency: " ", recurrence_ends_on: "not a date" }),
    ).toBeNull();
  });

  it("still compares the calendar date, not the optional time, to the first meeting", () => {
    const firstMeeting = { ...weekly, starts_at: "2026-10-04 20:00", timezone: "Europe/London" };
    expect(fieldsOf({ ...firstMeeting, recurrence_ends_on: "2026-10-03T23:59:59" })).toEqual({
      recurrence_ends_on: "The repeat-until date is before the first meeting.",
    });
    expect(
      parseRecurrenceForm({
        ...firstMeeting,
        recurrence_ends_on: "2026-10-04T00:00:00",
      })?.endsOn?.toISOString(),
    ).toBe("2026-10-04T00:00:00.000Z");
    expect(fieldsOf({ ...firstMeeting, recurrence_ends_on: "2026-10-03T24:00" })).toEqual(
      invalidDate,
    );
  });
});
