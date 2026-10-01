import { describe, expect, it } from "vitest";
import { MAX_OCCURRENCES, parseRecurrenceForm } from "../src/admin/recurrence";
import { ValidationError } from "../src/admin/validation";

const weekly = { recurrence_frequency: "weekly" };
const rangeError = { recurrence_count: `Occurrences must be between 1 and ${MAX_OCCURRENCES}.` };

function fieldsOf(data: Record<string, unknown>) {
  try {
    parseRecurrenceForm(data);
  } catch (e) {
    if (e instanceof ValidationError) return e.fields;
    throw e;
  }
  return null;
}

describe("recurrence occurrence count validation", () => {
  it.each([
    "0.9", "1.5", "3.9", `${MAX_OCCURRENCES - 1}.5`, `${MAX_OCCURRENCES}.9`,
    "3.9e0", "0", "-0", "-1", "-3.9", String(MAX_OCCURRENCES + 1),
    "Infinity", "+Infinity", "-Infinity", "NaN", "1e309", "-1e309", "abc", "3x",
  ])("refuses invalid count %j with a recurrence_count field error", (recurrence_count) => {
    expect(fieldsOf({ ...weekly, recurrence_count })).toEqual(rangeError);
  });

  // Number() rounds each of these to an integer in range before isInteger sees
  // it; the literal still names a fraction, so it is refused.
  it.each([
    "3.0000000000000001", "52.0000000000000001", "0.99999999999999999",
    "51.99999999999999999", "1.0000000000000000001", "5.2000000000000001e1",
  ])("refuses %j, which Number() rounds to a whole number", (recurrence_count) => {
    expect(fieldsOf({ ...weekly, recurrence_count })).toEqual(rangeError);
  });

  it.each(["1.5", "3.9", `${MAX_OCCURRENCES}.9`, "Infinity", "0", String(MAX_OCCURRENCES + 1)])(
    "does not let a valid ends-on date mask invalid count %j",
    (recurrence_count) => {
      expect(fieldsOf({ ...weekly, recurrence_count, recurrence_ends_on: "2026-10-25" })).toEqual(rangeError);
    },
  );

  it.each([1, MAX_OCCURRENCES])("accepts the exact boundary %i", (count) => {
    expect(parseRecurrenceForm({ ...weekly, recurrence_count: String(count) })).toEqual({
      frequency: "weekly", count, endsOn: null,
    });
  });

  // Retain Number()'s existing lexical forms, not a new digits-only grammar.
  it.each([
    ["3", 3], [" 3\t", 3], ["03", 3], ["+3", 3], ["3.0", 3], ["3e0", 3],
    ["30e-1", 3], ["0x3", 3], ["0b11", 3], ["0o3", 3],
    ["1.0", 1], ["52.0", MAX_OCCURRENCES], ["5.2e1", MAX_OCCURRENCES],
    ["52.00000000000000000", MAX_OCCURRENCES], ["1.0000000000000000e1", 10],
  ])("preserves whole-number lexical form %j as %i", (recurrence_count, count) => {
    expect(parseRecurrenceForm({ ...weekly, recurrence_count })).toEqual({
      frequency: "weekly", count, endsOn: null,
    });
  });

  it.each([undefined, null, "", " \t\n "])("retains ends-on rules with blank count %j", (recurrence_count) => {
    expect(parseRecurrenceForm({
      ...weekly, recurrence_count, recurrence_ends_on: "2026-10-25",
      starts_at: "2026-10-04 20:00", timezone: "Europe/London",
    })).toEqual({ frequency: "weekly", count: null, endsOn: new Date("2026-10-25T00:00:00.000Z") });
  });

  it("retains both bounds when count and ends-on are supplied", () => {
    expect(parseRecurrenceForm({ ...weekly, recurrence_count: "3", recurrence_ends_on: "2026-10-25" })).toEqual({
      frequency: "weekly", count: 3, endsOn: new Date("2026-10-25T00:00:00.000Z"),
    });
  });

  it("still requires a bound and rejects an ends-on date before the first meeting", () => {
    expect(fieldsOf({ ...weekly, recurrence_count: " " })).toEqual({
      recurrence_count: "Give a number of occurrences or a repeat-until date.",
    });
    expect(fieldsOf({
      ...weekly, recurrence_count: "", recurrence_ends_on: "2026-10-01",
      starts_at: "2026-10-04 20:00", timezone: "Europe/London",
    })).toEqual({ recurrence_ends_on: "The repeat-until date is before the first meeting." });
  });

  it("keeps count and date errors together rather than returning a partial rule", () => {
    expect(fieldsOf({ ...weekly, recurrence_count: "3.9", recurrence_ends_on: "soon" })).toEqual({
      ...rangeError, recurrence_ends_on: "The repeat-until date is not a date.",
    });
  });

  it.each([undefined, null, "", " \t\n "])("retains one-off behavior for frequency %j", (recurrence_frequency) => {
    expect(parseRecurrenceForm({ recurrence_frequency, recurrence_count: "3.9", recurrence_ends_on: "soon" })).toBeNull();
  });
});
