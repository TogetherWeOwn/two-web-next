import { describe, expect, it, vi } from "vitest";
import { ValidationError, wallToUtc } from "../src/admin/validation";

describe("admin wall-time formatter lifecycle", () => {
  it("constructs one renderer per parse, without reusing another zone's formatter", () => {
    const constructors = vi.spyOn(Intl, "DateTimeFormat");
    try {
      expect(wallToUtc("2026-07-15 20:00", "UTC").toISOString()).toBe("2026-07-15T20:00:00.000Z");
      // One timezone check and one renderer, not a renderer for every sample.
      expect(constructors).toHaveBeenCalledTimes(2);
      expect(wallToUtc("2026-07-15 20:00", "Europe/London").toISOString()).toBe("2026-07-15T19:00:00.000Z");
      expect(constructors).toHaveBeenCalledTimes(4);
    } finally { constructors.mockRestore(); }
  });

  it("reuses the renderer while still rejecting a spring-forward gap", () => {
    const constructors = vi.spyOn(Intl, "DateTimeFormat");
    try {
      expect(() => wallToUtc("2026-03-29 01:30", "Europe/London")).toThrow(ValidationError);
      expect(constructors).toHaveBeenCalledTimes(2);
    } finally { constructors.mockRestore(); }
  });
});
