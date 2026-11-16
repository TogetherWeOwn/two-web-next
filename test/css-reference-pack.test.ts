import { describe, expect, it } from "vitest";
import { referencePack } from "./helpers/css-reference-pack";

describe("CSS reference packer", () => {
  it("leaves short and non-ASCII input unchanged", () => {
    expect(referencePack("雪😀abc")).toEqual({ packed: "雪😀abc", dictionary: [] });
  });

  it("uses position-first tie order and non-overlapping occurrences", () => {
    expect(referencePack(`${"a".repeat(16)}雪${"b".repeat(16)}`)).toEqual({
      packed: "\u0080\u0080\u0080\u0080雪\u0081\u0081\u0081\u0081",
      dictionary: ["aaaa", "bbbb"],
    });
  });

  it("accounts for JSON escaping and UTF-8 marker bytes", () => {
    expect(referencePack(`😀${'"'.repeat(16)}雪`)).toEqual({
      packed: "😀\u0080\u0080\u0080\u0080雪",
      dictionary: ['""""'],
    });
  });

  it("exhausts the budget before a round without consuming visits", () => {
    const budget = { visits: 27, exhausted: false };
    expect(referencePack("a".repeat(16), budget)).toEqual({
      packed: "aaaaaaaaaaaaaaaa",
      dictionary: [],
    });
    expect(budget).toEqual({ visits: 27, exhausted: true });
  });

  it("retains the last complete round when the next exceeds the budget", () => {
    const budget = { visits: 28, exhausted: false };
    expect(referencePack("a".repeat(16), budget)).toEqual({
      packed: "\u0080\u0080\u0080\u0080",
      dictionary: ["aaaa"],
    });
    expect(budget).toEqual({ visits: 0, exhausted: true });
  });
});
