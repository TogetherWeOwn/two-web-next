import { describe, expect, it } from "vitest";
import { formatAdminTime } from "../src/admin/chronology";

describe("admin chronology adapter", () => {
  it.each([
    new Date("2026-10-01T12:34:56.789Z"),
    "2026-10-01T12:34:56.789Z",
    Date.parse("2026-10-01T12:34:56.789Z"),
    "2026-10-01T14:34:56.789+02:00",
  ])("preserves the precise instant and displays UTC for %s", (value) => {
    expect(formatAdminTime(value)).toEqual({
      iso: "2026-10-01T12:34:56.789Z",
      label: "2026-10-01 12:34:56 UTC",
    });
  });

  it("keeps epoch zero instead of treating it as absent", () => {
    expect(formatAdminTime(0)).toEqual({
      iso: "1970-01-01T00:00:00.000Z",
      label: "1970-01-01 00:00:00 UTC",
    });
  });

  it.each([
    null,
    undefined,
    new Date(Number.NaN),
    Number.NaN,
    Infinity,
    -Infinity,
    1e20,
    "",
    " ",
    "not-a-timestamp",
    "2026-10-01T12:34:56",
    "1",
    true,
    {},
  ])("does not fabricate an instant from %s", (value) => {
    expect(formatAdminTime(value)).toEqual({ iso: null, label: "Time unavailable" });
  });
});
