// Wrong-type timezone must be a 422, never a silent reset to the default
// zone. A supplied non-string timezone previously fell through `str()` to
// null and was stored as Europe/London — the same silent-replace shape as
// the game/description/location guard above it.
import { describe, expect, it } from "vitest";
import { ValidationError, parseEventForm } from "../src/admin/validation";

const base = {
  title: "Game night",
  starts_at: "2026-07-15 20:00",
  ends_at: "2026-07-15 22:00",
};

const errors = (fn: () => unknown): Record<string, string> => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.fields;
    throw e;
  }
  throw new Error("expected a ValidationError");
};

describe("wrong-type event timezone", () => {
  it.each([5, {}, ["America/New_York"], true])(
    "refuses timezone %j with the field-specific 422 shape",
    (timezone) => {
      expect(errors(() => parseEventForm({ ...base, timezone }))).toEqual({
        timezone: "The timezone must be text.",
      });
    },
  );

  it("keeps the default zone for omitted, null and blank timezones", () => {
    expect(parseEventForm({ ...base }).timezone).toBe("Europe/London");
    expect(parseEventForm({ ...base, timezone: null }).timezone).toBe("Europe/London");
    expect(parseEventForm({ ...base, timezone: "   " }).timezone).toBe("Europe/London");
  });

  it("keeps refusing an unknown zone by name, not with the type message", () => {
    expect(errors(() => parseEventForm({ ...base, timezone: "Mars/Olympus" }))).toEqual({
      timezone: "Unknown timezone: Mars/Olympus.",
    });
  });

  it("keeps storing a valid supplied zone", () => {
    expect(parseEventForm({ ...base, timezone: "America/New_York" }).timezone).toBe(
      "America/New_York",
    );
  });
});

describe("wrong-type accessibility notes", () => {
  it.each([5, {}, ["Step-free entrance"], true])(
    "refuses accessibility_notes %j with the field-specific 422 shape",
    (accessibility_notes) => {
      expect(errors(() => parseEventForm({ ...base, accessibility_notes }))).toEqual({
        accessibility_notes: "The accessibility_notes must be text.",
      });
    },
  );

  it("keeps omitted, null and blank notes nullable", () => {
    expect(parseEventForm({ ...base }).accessibilityNotes).toBeNull();
    expect(parseEventForm({ ...base, accessibility_notes: null }).accessibilityNotes).toBeNull();
    expect(parseEventForm({ ...base, accessibility_notes: "   " }).accessibilityNotes).toBeNull();
  });

  it("keeps storing valid accessibility notes", () => {
    expect(
      parseEventForm({ ...base, accessibility_notes: "Step-free entrance" }).accessibilityNotes,
    ).toBe("Step-free entrance");
  });
});
