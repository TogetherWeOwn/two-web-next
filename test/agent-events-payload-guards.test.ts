// Offline guards in src/agent-events/payload.ts. timingSafeEqualHex decides
// an idempotency replay conflict (409), so a digest that is only a prefix of
// the stored one must never compare equal. validateFields refuses non-object
// bodies, non-string text and non-string wall times without throwing.
import { describe, expect, it } from "vitest";
import { timingSafeEqualHex, validateFields } from "../src/agent-events/payload";

const FIELDS = {
  title: "Game night",
  starts_at: "2026-11-02 19:00",
  ends_at: "2026-11-02 21:00",
  timezone: "Europe/London",
  location: "Discord stage",
};

describe("timingSafeEqualHex", () => {
  it("is true only for identical strings", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
  });

  it("never matches a prefix in either direction", () => {
    expect(timingSafeEqualHex("ab", "abcd")).toBe(false);
    expect(timingSafeEqualHex("abcd", "ab")).toBe(false);
    expect(timingSafeEqualHex("", "ab")).toBe(false);
  });
});

describe("validateFields shape refusals", () => {
  it("accepts the baseline fields", () => {
    expect(validateFields(FIELDS)).toMatchObject({ ok: true });
  });

  it.each([null, "fields", 42, ["title"]])("refuses a non-object body %j", (raw) => {
    expect(validateFields(raw)).toEqual({
      ok: false,
      errors: { fields: ["An object of event `fields` is required."] },
    });
  });

  it("refuses non-string text fields", () => {
    const result = validateFields({ ...FIELDS, title: 7, game: { name: "x" } });
    expect(result).toMatchObject({
      ok: false,
      errors: {
        title: ["The title field must be a string."],
        game: ["The game field must be a string."],
      },
    });
  });

  it("refuses non-string wall times", () => {
    const result = validateFields({ ...FIELDS, starts_at: 1_793_000_000_000 });
    expect(result).toMatchObject({
      ok: false,
      errors: {
        starts_at: ["The starts_at field must be a real wall time formatted YYYY-MM-DD HH:MM."],
      },
    });
  });
});
