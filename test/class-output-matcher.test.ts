import { describe, expect, it } from "vitest";
import {
  budget,
  matches,
  opaque,
  sequence,
  targetMatcher,
  text,
} from "./support/class-output-matcher";

const hidden = targetMatcher("hidden");

describe("bounded class output matching", () => {
  it("matches whole tokens across nodes, not substrings", () => {
    expect(matches(sequence(text("hid"), text("den")), hidden)).toBe(true);
    for (const value of ["hiddenx", "xhidden", "hidden-ish", "sm:hidden", "hid den"]) {
      expect(matches(text(value), hidden), value).toBe(false);
    }
  });

  it("keeps unknown output as a barrier", () => {
    expect(matches(sequence(text("hid"), opaque, text("den")), hidden)).toBe(false);
    expect(matches(sequence(text("hidden"), opaque), hidden)).toBe(false);
    expect(matches(sequence(opaque, text("hidden")), hidden)).toBe(false);
    expect(matches(sequence(text("hidden "), opaque), hidden)).toBe(true);
    expect(matches(sequence(opaque, text(" hidden")), hidden)).toBe(true);
  });

  it("fails closed at the work and depth limits with fresh accounting", () => {
    const value = sequence(text("hidden"));
    expect(() => matches(value, hidden, budget(1))).toThrow("class output work limit");
    expect(matches(value, hidden)).toBe(true);
    let deep = text("hint");
    for (let i = 0; i < 130; i++) deep = sequence(deep);
    expect(() => matches(deep, hidden)).toThrow("class output depth limit");
  });
});
