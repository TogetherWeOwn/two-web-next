import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import { evaluate } from "../ci/rum-check.mjs";

const budget = { lcpMs: 2500, cls: 0.1, inpMs: 200, minSamples: 50 };
type Row = { name: string; value: number | null };

describe("ci/rum-check.mjs", () => {
  it("passes within budget", () => {
    // Fixtures are in API units: LCP/INP p75 in microseconds, CLS unitless.
    const r = evaluate(
      {
        largestContentfulPaintP75: 1_800_000,
        cumulativeLayoutShiftP75: 0.05,
        interactionToNextPaintP75: 150_000,
      },
      budget,
      500,
    );
    expect(r.failed).toHaveLength(0);
    expect(r.rows.map((x: Row) => x.value)).toEqual([1800, 0.05, 150]);
  });

  it("fails when any p75 is over budget", () => {
    const r = evaluate(
      {
        largestContentfulPaintP75: 3_100_000,
        cumulativeLayoutShiftP75: 0.05,
        interactionToNextPaintP75: 150_000,
      },
      budget,
      500,
    );
    expect(r.failed.map((x: Row) => x.name)).toEqual(["LCP p75 (ms)"]);
  });

  it("never fails with too few samples", () => {
    const r = evaluate(
      {
        largestContentfulPaintP75: 9_000_000,
        cumulativeLayoutShiftP75: 1,
        interactionToNextPaintP75: 900_000,
      },
      budget,
      10,
    );
    expect(r.enoughData).toBe(false);
    expect(r.failed).toHaveLength(0);
  });

  it("reports missing metrics as n/a, not failures", () => {
    const r = evaluate({}, budget, 500);
    expect(r.failed).toHaveLength(0);
    expect(r.rows.every((x: Row) => x.value === null)).toBe(true);
  });

  it("reports the API negative N/A value as n/a, not a pass", () => {
    const r = evaluate(
      {
        largestContentfulPaintP75: -1,
        cumulativeLayoutShiftP75: -1,
        interactionToNextPaintP75: -1,
      },
      budget,
      500,
    );
    expect(r.failed).toHaveLength(0);
    expect(r.rows.every((x: Row) => x.value === null)).toBe(true);
  });
});
