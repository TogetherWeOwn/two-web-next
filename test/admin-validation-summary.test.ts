import { describe, expect, it } from "vitest";
import { validationSummary } from "../src/admin/form-errors";

describe("admin correction target boundaries", () => {
  it("keeps recurrence errors visible but untargeted on edit without recurrence controls", () => {
    const errors = { recurrence_count: "Choose at most 52 occurrences." };
    expect(validationSummary(errors, "event", "edit")).toEqual([
      { key: "recurrence_count", message: errors.recurrence_count, label: null, target: null },
    ]);
    expect(validationSummary(errors, "event", "new")[0]?.target).toBe("f-recurrence-count");
  });

  it("does not mistake prototype names or immutable keys for controls", () => {
    const errors = JSON.parse(
      '{"toString":"Try again.","__proto__":"Refused.","event_key":"Immutable."}',
    );
    const entries = validationSummary(errors, "event", "new");
    expect(entries.map(({ message }) => message)).toEqual(["Try again.", "Refused.", "Immutable."]);
    expect(entries.every(({ target, label }) => target === null && label === null)).toBe(true);
  });

  it("never links a field belonging to the other editor", () => {
    expect(validationSummary({ image_url: "Refused." }, "event", "new")[0]?.target).toBeNull();
    expect(validationSummary({ capacity: "Refused." }, "featured", "new")[0]?.target).toBeNull();
  });

  it("does not manufacture an error for an error-free form", () => {
    expect(validationSummary({}, "event", "new")).toEqual([]);
    expect(validationSummary({}, "featured", "edit")).toEqual([]);
  });
});
