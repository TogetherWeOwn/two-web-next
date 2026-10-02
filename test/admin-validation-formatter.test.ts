import { expect, it, vi } from "vitest";
import { ValidationError, wallToUtc } from "../src/admin/validation";

it("reuses one wall formatter across all offset samples without changing fold resolution", () => {
  const formatter = vi.spyOn(Intl, "DateTimeFormat");
  try {
    expect(wallToUtc("2026-10-25 01:30", "Europe/London").toISOString()).toBe("2026-10-25T01:30:00.000Z");
    // One timezone validation and one renderer, not a renderer for every sample.
    expect(formatter).toHaveBeenCalledTimes(2);
    expect(formatter.mock.calls.filter(([, options]) => options?.year === "numeric")).toHaveLength(1);
  } finally {
    formatter.mockRestore();
  }
});

it("still rejects an unknown zone before constructing the wall formatter", () => {
  const formatter = vi.spyOn(Intl, "DateTimeFormat");
  try {
    expect(() => wallToUtc("2026-10-25 01:30", "Not/AZone")).toThrow(ValidationError);
    expect(formatter).toHaveBeenCalledTimes(1);
  } finally {
    formatter.mockRestore();
  }
});
