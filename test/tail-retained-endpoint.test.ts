import { describe, expect, it } from "vitest";
import { AggregateTracker } from "../tail/worker";

const AT = Date.parse("2026-10-20T12:00:00.000Z");
const SCRIPT = "two-web-next";
const observe = (tracker: AggregateTracker, at: number, crashes = 0) =>
  tracker.observe({ script: SCRIPT, at, requests: 0, errors: 0, crashes });

describe("retained endpoint snapshot integrity", () => {
  it("persists the exact endpoint, including zero-count observations and late revisits", () => {
    const tracker = new AggregateTracker();
    observe(tracker, AT + 15_000, 4);
    observe(tracker, AT + 20_000);
    observe(tracker, AT - 60_000);
    expect(tracker.snapshot()[SCRIPT]?.windowEndAt).toBe(AT + 20_000);
    const restored = new AggregateTracker();
    restored.restore(JSON.parse(JSON.stringify(tracker.snapshot())));
    expect(restored.snapshot()).toEqual(tracker.snapshot());
    expect(observe(restored, AT - 6 * 60_000, 5)).toBeNull();
    expect(restored.snapshot()).toEqual(tracker.snapshot());
  });

  it("retains an endpoint even when no stored bucket remains", () => {
    const tracker = new AggregateTracker();
    tracker.restore({
      [SCRIPT]: { buckets: [], cooldownUntil: 0, windowEndAt: AT },
    });
    expect(observe(tracker, AT - 6 * 60_000, 5)).toBeNull();
    expect(tracker.snapshot()[SCRIPT]).toMatchObject({ buckets: [], windowEndAt: AT });
    expect(observe(tracker, AT, 5)).toMatchObject({ crashes: 5 });
  });

  it.each([undefined, null, "invalid", -1, Number.NaN, AT - 60_000])(
    "derives a safe endpoint when a stored endpoint is missing, invalid or behind a bucket (%s)",
    (windowEndAt) => {
      const tracker = new AggregateTracker();
      tracker.restore({
        [SCRIPT]: {
          buckets: [
            { at: AT, requests: 0, errors: 0, crashes: 4 },
            { at: AT - 6 * 60_000, requests: 100, errors: 0, crashes: 0 },
          ],
          cooldownUntil: 0,
          windowEndAt,
        },
      });
      expect(tracker.snapshot()[SCRIPT]?.windowEndAt).toBe(AT);
      expect(tracker.snapshot()[SCRIPT]?.buckets).toHaveLength(1);
      expect(observe(tracker, AT - 60_000, 1)).toMatchObject({ crashes: 5, requests: 0 });
    },
  );

  it("resetTo replaces the endpoint and removes scripts created by an uncommitted observation", () => {
    const tracker = new AggregateTracker();
    observe(tracker, AT + 15_000, 4);
    const prior = structuredClone(tracker.snapshot());
    observe(tracker, AT + 6 * 60_000, 5);
    tracker.observe({ script: "two-web-jobs", at: AT, requests: 0, errors: 0, crashes: 5 });
    tracker.resetTo(prior);
    expect(tracker.snapshot()).toEqual(prior);
    expect(tracker.snapshot()[SCRIPT]?.windowEndAt).toBe(AT + 15_000);
    expect(observe(tracker, AT - 60_000, 1)).toMatchObject({ crashes: 5 });
  });
});
