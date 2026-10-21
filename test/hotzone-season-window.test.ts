// Acceptance (test files only): every admitted `?season=` maps to its literal
// UTC start-inclusive / end-exclusive window, including years 0000..0099.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// Today src/hotzones/season.ts:12-54 builds windows with `Date.UTC(year, …)`,
// which shifts years 0000..0099 to 1900..1999 (Date.UTC's two-digit-year
// mapping). The grammar (YYYY, YYYY-MM, YYYY-QN, all/absent, invalid -> null)
// stays unchanged; only the window arithmetic becomes literal.
//
// How this fails before the Builder lands: every 0000..0099 case fails —
// "0000" starts at 1900-01-01 instead of 0000-01-01, "0099" starts at
// 1999-01-01, "0099-Q4" ends at 2000-01-01 instead of 0100-01-01 — while the
// 2026 controls and the invalid-grammar controls stay green. Representation
// mutants (Date.UTC restored for any early year) fail these tests. Pure
// date tests only: no DB, no network, no rendering.
import { describe, expect, it } from "vitest";
import { inSeasonWindow, parseSeasonParam } from "../src/hotzones/season";

const expectWindow = (raw: string, startIso: string, endIso: string) => {
  const window = parseSeasonParam(raw);
  expect(window, raw).not.toBeNull();
  if (window?.kind !== "window") throw new Error(`expected window for ${raw}`);
  expect(window.start.toISOString(), `${raw} start`).toBe(startIso);
  expect(window.end.toISOString(), `${raw} end`).toBe(endIso);
  expect(window.label, `${raw} label`).toBe(raw);
};

describe("hot-zone season windows (literal UTC)", () => {
  it.each([null, undefined, "all"])("maps %j to the unbounded all window", (raw) => {
    const window = parseSeasonParam(raw);
    expect(window).toEqual({ kind: "all", label: "all" });
  });

  it.each([
    ["2026", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    ["2025", "2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["0100", "0100-01-01T00:00:00.000Z", "0101-01-01T00:00:00.000Z"],
  ])("maps year %s to %s..%s", (raw, start, end) => expectWindow(raw, start, end));

  it.each([
    ["2026-01", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
    ["2026-09", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    ["2026-12", "2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    ["2024-02", "2024-02-01T00:00:00.000Z", "2024-03-01T00:00:00.000Z"],
    ["0100-01", "0100-01-01T00:00:00.000Z", "0100-02-01T00:00:00.000Z"],
  ])("maps month %s to %s..%s", (raw, start, end) => expectWindow(raw, start, end));

  it.each([
    ["2026-Q1", "2026-01-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"],
    ["2026-Q2", "2026-04-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
    ["2026-Q3", "2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    ["2026-Q4", "2026-10-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    ["0100-Q1", "0100-01-01T00:00:00.000Z", "0100-04-01T00:00:00.000Z"],
  ])("maps quarter %s to %s..%s", (raw, start, end) => expectWindow(raw, start, end));
});

describe("hot-zone season windows (years 0000..0099 stay literal)", () => {
  it.each([
    ["0000", "0000-01-01T00:00:00.000Z", "0001-01-01T00:00:00.000Z"],
    ["0001", "0001-01-01T00:00:00.000Z", "0002-01-01T00:00:00.000Z"],
    ["0010", "0010-01-01T00:00:00.000Z", "0011-01-01T00:00:00.000Z"],
    ["0099", "0099-01-01T00:00:00.000Z", "0100-01-01T00:00:00.000Z"],
  ])("maps year %s to %s..%s, never 19xx", (raw, start, end) => expectWindow(raw, start, end));

  it.each([
    ["0000-01", "0000-01-01T00:00:00.000Z", "0000-02-01T00:00:00.000Z"],
    ["0000-12", "0000-12-01T00:00:00.000Z", "0001-01-01T00:00:00.000Z"],
    ["0099-01", "0099-01-01T00:00:00.000Z", "0099-02-01T00:00:00.000Z"],
    ["0099-02", "0099-02-01T00:00:00.000Z", "0099-03-01T00:00:00.000Z"],
    ["0099-12", "0099-12-01T00:00:00.000Z", "0100-01-01T00:00:00.000Z"],
  ])("maps month %s to %s..%s, never 19xx", (raw, start, end) => expectWindow(raw, start, end));

  it.each([
    ["0000-Q1", "0000-01-01T00:00:00.000Z", "0000-04-01T00:00:00.000Z"],
    ["0000-Q4", "0000-10-01T00:00:00.000Z", "0001-01-01T00:00:00.000Z"],
    ["0099-Q1", "0099-01-01T00:00:00.000Z", "0099-04-01T00:00:00.000Z"],
    ["0099-Q4", "0099-10-01T00:00:00.000Z", "0100-01-01T00:00:00.000Z"],
  ])("maps quarter %s to %s..%s, never 19xx/20xx", (raw, start, end) =>
    expectWindow(raw, start, end),
  );

  it("keeps the 0099->0100 boundary continuous: each 0099 window ends where 0100 begins", () => {
    for (const [before, after] of [
      ["0099", "0100"],
      ["0099-12", "0100-01"],
      ["0099-Q4", "0100-Q1"],
    ] as const) {
      const a = parseSeasonParam(before);
      const b = parseSeasonParam(after);
      if (a?.kind !== "window" || b?.kind !== "window") throw new Error("expected windows");
      expect(a.end.toISOString(), `${before} end`).toBe("0100-01-01T00:00:00.000Z");
      expect(b.start.toISOString(), `${after} start`).toBe("0100-01-01T00:00:00.000Z");
      expect(a.end.getTime(), `${before} end == ${after} start`).toBe(b.start.getTime());
    }
  });

  it("keeps year/quarter boundaries exact at both ends of the early range", () => {
    // 0000-Q4 ends where 0001 begins; 0099-Q4 ends where 0100 begins.
    const q4 = parseSeasonParam("0000-Q4");
    const next = parseSeasonParam("0001");
    if (q4?.kind !== "window" || next?.kind !== "window") throw new Error("expected windows");
    expect(q4.end.toISOString()).toBe("0001-01-01T00:00:00.000Z");
    expect(q4.end.getTime()).toBe(next.start.getTime());
  });
});

describe("hot-zone season windows (start-inclusive / end-exclusive)", () => {
  it("includes the start instant and excludes the end instant for a normal year", () => {
    const window = parseSeasonParam("2026");
    if (window?.kind !== "window") throw new Error("expected window");
    expect(inSeasonWindow(new Date("2026-01-01T00:00:00.000Z"), window)).toBe(true);
    expect(inSeasonWindow(new Date("2026-06-15T12:00:00.000Z"), window)).toBe(true);
    expect(inSeasonWindow(new Date("2026-12-31T23:59:59.999Z"), window)).toBe(true);
    expect(inSeasonWindow(new Date("2027-01-01T00:00:00.000Z"), window)).toBe(false);
    expect(inSeasonWindow(new Date("2025-12-31T23:59:59.999Z"), window)).toBe(false);
  });

  it("includes the start instant and excludes the end instant for year 0099", () => {
    const window = parseSeasonParam("0099");
    if (window?.kind !== "window") throw new Error("expected window");
    expect(inSeasonWindow(new Date("0099-01-01T00:00:00.000Z"), window)).toBe(true);
    expect(inSeasonWindow(new Date("0099-06-15T12:00:00.000Z"), window)).toBe(true);
    expect(inSeasonWindow(new Date("0099-12-31T23:59:59.999Z"), window)).toBe(true);
    expect(inSeasonWindow(new Date("0100-01-01T00:00:00.000Z"), window)).toBe(false);
    expect(inSeasonWindow(new Date("0098-12-31T23:59:59.999Z"), window)).toBe(false);
  });

  it("includes the start instant and excludes the end instant for month 0000-01", () => {
    const window = parseSeasonParam("0000-01");
    if (window?.kind !== "window") throw new Error("expected window");
    expect(inSeasonWindow(new Date("0000-01-01T00:00:00.000Z"), window)).toBe(true);
    expect(inSeasonWindow(new Date("0000-01-15T12:00:00.000Z"), window)).toBe(true);
    expect(inSeasonWindow(new Date("0000-02-01T00:00:00.000Z"), window)).toBe(false);
  });

  it("treats all as unbounded", () => {
    const window = parseSeasonParam(null);
    if (window?.kind !== "all") throw new Error("expected all");
    expect(inSeasonWindow(new Date("0099-06-15T12:00:00.000Z"), window)).toBe(true);
    expect(inSeasonWindow(new Date("2026-06-15T12:00:00.000Z"), window)).toBe(true);
  });
});

describe("hot-zone season grammar (invalid stays invalid)", () => {
  it.each([
    "presence",
    "last-season",
    "2026-13",
    "2026-00",
    "2026-9",
    "2026-Q5",
    "2026-Q0",
    "2026-q3",
    "Q3-2026",
    "2026/09",
    "26",
    " 2026",
    "2026 ",
    "",
  ])("rejects %j with null, never a silent fallback window", (raw) => {
    expect(parseSeasonParam(raw)).toBeNull();
  });
});
