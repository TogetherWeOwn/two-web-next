// route-inventory: GET /leaderboards/members
// Parser-edge pins for `?activity=` beside the savable-games acceptance
// file: the length rule mirrors the event form exactly (trimmed code points
// counted before lowercasing), and `all` selects the game named All.
import { describe, expect, it } from "vitest";
import { ACTIVITY_MAX_LENGTH, parseActivityParam } from "../src/leaderboards/members";

describe("activity parser edges: save-side counting and the All game", () => {
  it("counts length before lowercasing: a savable 100-char İ name is admitted", () => {
    // İ (U+0130) lowercases to two code points (i + combining dot), so a
    // lowercase-first count would see 101 and 400 a name the event form saves.
    const savable = "İ" + "a".repeat(99);
    expect([...savable].length).toBe(100);
    expect([...savable.toLowerCase()].length).toBe(101); // lowercase-first would 400 this
    expect(parseActivityParam(savable)).toEqual({ ok: true, game: savable.toLowerCase() });
    const overlong = "İ" + "a".repeat(100);
    expect([...overlong].length).toBe(101);
    expect(parseActivityParam(overlong).ok).toBe(false);
  });

  it("counts code points, not UTF-16 units: 100 emoji admitted, 101 refused", () => {
    const hundred = "😀".repeat(100);
    expect([...hundred].length).toBe(100);
    expect(hundred.length).toBe(200); // a `.length` mutant refuses this row
    expect(parseActivityParam(hundred)).toEqual({ ok: true, game: hundred });
    expect(parseActivityParam("😀".repeat(101)).ok).toBe(false);
    expect(ACTIVITY_MAX_LENGTH).toBe(100);
  });

  it("selects the game named All while blank stays every game", () => {
    for (const raw of ["all", "ALL", "  all  "])
      expect(parseActivityParam(raw)).toEqual({ ok: true, game: "all" });
    for (const raw of [null, undefined, "", "   "])
      expect(parseActivityParam(raw)).toEqual({ ok: true, game: null });
  });
});
