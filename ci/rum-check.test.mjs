import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "./rum-check.mjs";

const budget = { lcpMs: 2500, cls: 0.1, inpMs: 200, minSamples: 50 };

test("within budget passes", () => {
  const r = evaluate(
    {
      largestContentfulPaintP75: 1800,
      cumulativeLayoutShiftP75: 0.05,
      interactionToNextPaintP75: 150,
    },
    budget,
    500,
  );
  assert.equal(r.failed.length, 0);
});

test("any p75 over budget fails", () => {
  const r = evaluate(
    {
      largestContentfulPaintP75: 3100,
      cumulativeLayoutShiftP75: 0.05,
      interactionToNextPaintP75: 150,
    },
    budget,
    500,
  );
  assert.deepEqual(
    r.failed.map((x) => x.name),
    ["LCP p75 (ms)"],
  );
});

test("too few samples never fails", () => {
  const r = evaluate(
    {
      largestContentfulPaintP75: 9000,
      cumulativeLayoutShiftP75: 1,
      interactionToNextPaintP75: 900,
    },
    budget,
    10,
  );
  assert.equal(r.enoughData, false);
  assert.equal(r.failed.length, 0);
});

test("missing metrics are reported as n/a, not failures", () => {
  const r = evaluate({}, budget, 500);
  assert.equal(r.failed.length, 0);
  assert.ok(r.rows.every((x) => x.value === null));
});
