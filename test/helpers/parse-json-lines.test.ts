import { describe, expect, it } from "vitest";
import { parseJsonLines } from "./parse-json-lines";

// Pins the fail-loud property: single-string calls that do not parse must
// land in `skipped` (never vanish), so a silent `try/catch → null` regression
// in the helper turns this suite red instead of passing on a filtered subset.

describe("parseJsonLines", () => {
  it("splits a valid JSON line from a non-JSON single-string line", () => {
    const raw = '{"event":"scheduled.failing"}';
    const { parsed, skipped } = parseJsonLines([[raw], ["not json at all"]]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ raw, value: { event: "scheduled.failing" } });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.raw).toBe("not json at all");
  });

  it("reports a non-string single-arg call as skipped", () => {
    const { parsed, skipped } = parseJsonLines([[42]]);

    expect(parsed).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it("ignores multi-arg plain-text calls", () => {
    const { parsed, skipped } = parseJsonLines([["agent-events failed", "some-name"]]);

    expect(parsed).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
