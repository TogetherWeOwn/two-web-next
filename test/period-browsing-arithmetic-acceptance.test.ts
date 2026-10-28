import { describe, expect, it } from "vitest";
import * as seasons from "../src/hotzones/season";
import type { SeasonWindow } from "../src/hotzones/season";

// Proposed pure seam for the test-first handoff. Namespace lookup lets the
// missing behavior fail as an assertion, not an import/typecheck failure.
type AdjacentLabels = { previous: string | null; next: string | null };
function adjacent(window: SeasonWindow): AdjacentLabels {
  const helper = (seasons as unknown as Record<string, unknown>).adjacentSeasonLabels;
  expect(
    helper,
    "PB_HELPER_MISSING: export adjacentSeasonLabels(SeasonWindow) from season.ts",
  ).toBeTypeOf("function");
  return (helper as (window: SeasonWindow) => AdjacentLabels)(window);
}

describe("period browsing: pure arithmetic", () => {
  it.each([
    ["PB-A01", "2026", "2025", "2027"],
    ["PB-A02", "2026-01", "2025-12", "2026-02"],
    ["PB-A03", "2025-12", "2025-11", "2026-01"],
    ["PB-A04", "2024-02", "2024-01", "2024-03"],
    ["PB-A05", "2026-Q1", "2025-Q4", "2026-Q2"],
    ["PB-A06", "2025-Q4", "2025-Q3", "2026-Q1"],
    ["PB-A07", "0000", null, "0001"],
    ["PB-A08", "9999", "9998", null],
    ["PB-A09", "0000-01", null, "0000-02"],
    ["PB-A10", "9999-12", "9999-11", null],
    ["PB-A11", "0000-Q1", null, "0000-Q2"],
    ["PB-A12", "9999-Q4", "9999-Q3", null],
    ["PB-A13", "0099-12", "0099-11", "0100-01"],
    ["PB-A14", "0100-Q1", "0099-Q4", "0100-Q2"],
    ["PB-A15", "all", null, null],
  ])("%s derives neighbors of %s without escaping the grammar", (_id, raw, previous, next) => {
    const window = seasons.parseSeasonParam(raw);
    expect(window).not.toBeNull();
    const before = JSON.stringify(window);
    const result = adjacent(window!);
    expect(result).toEqual({ previous, next });
    expect(JSON.stringify(window), "PB_INPUT_MUTATED: keep arithmetic pure").toBe(before);
    for (const label of [result.previous, result.next]) {
      if (label !== null) expect(seasons.parseSeasonParam(label)).not.toBeNull();
    }
  });

  it.each([
    ["PB-C01", "2025-12", "2025-12-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["PB-C02", "2024-02", "2024-02-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z"],
    ["PB-C03", "2025-Q4", "2025-10-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["PB-C04", "0000", "0000-01-01T00:00:00.000Z", "0001-01-01T00:00:00.000Z"],
    ["PB-C05", "9999-12", "9999-12-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z"],
  ])("%s retains UTC half-open bounds for %s", (_id, raw, start, end) => {
    const window = seasons.parseSeasonParam(raw);
    expect(window?.kind).toBe("window");
    if (window?.kind !== "window") throw new Error("PB_WINDOW_MISSING");
    expect(window.start.toISOString()).toBe(start);
    expect(window.end.toISOString()).toBe(end);
    expect(seasons.inSeasonWindow(new Date(start), window)).toBe(true);
    expect(seasons.inSeasonWindow(new Date(Date.parse(start) - 1), window)).toBe(false);
    expect(seasons.inSeasonWindow(new Date(Date.parse(end) - 1), window)).toBe(true);
    expect(seasons.inSeasonWindow(new Date(end), window)).toBe(false);
  });

  it.each([
    "",
    "2026-00",
    "2026-13",
    "2026-Q0",
    "2026-Q5",
    "2026-q1",
    "10000",
    "-001",
    "2026-1",
    " 2026",
    "2026 ",
    "2026-02-01",
    "2026%2D01",
  ])("PB-C06 refuses malformed season %j instead of normalizing it", (raw) =>
    expect(seasons.parseSeasonParam(raw)).toBeNull(),
  );

  it("PB-C07 retains absent/all and UTC shortcuts at the local-year boundary", () => {
    expect(seasons.parseSeasonParam(undefined)).toEqual({ kind: "all", label: "all" });
    expect(seasons.parseSeasonParam(null)).toEqual({ kind: "all", label: "all" });
    expect(seasons.utcPeriodShortcuts(new Date("2025-12-31T23:59:59.999Z"))).toEqual({
      month: "2025-12",
      quarter: "2025-Q4",
    });
    expect(seasons.utcPeriodShortcuts(new Date("2026-01-01T00:00:00.000Z"))).toEqual({
      month: "2026-01",
      quarter: "2026-Q1",
    });
  });
});
