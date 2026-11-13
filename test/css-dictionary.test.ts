import { describe, expect, it } from "vitest";
import { packCss } from "../ci/css-dictionary.mjs";
import { decodeCssDictionary } from "../src/css-dictionary";

// The original position-first scan defines the packed representation, including
// tie order. Keep this independent reference for small, adversarial fixtures.
function referencePack(css: string, budget?: { visits: number; exhausted: boolean }) {
  let packed = css;
  const dictionary: string[] = [];
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  while (dictionary.length < 80) {
    const roundVisits = [4, 8, 12, 16, 20, 24].reduce(
      (total, length) => total + Math.max(0, packed.length - length + 1),
      0,
    );
    if (budget && budget.visits < roundVisits) {
      budget.exhausted = true;
      break;
    }
    if (budget) budget.visits -= roundVisits;
    const counts = new Map<string, { count: number; end: number }>();
    for (let start = 0; start < packed.length; start++) {
      for (const length of [4, 8, 12, 16, 20, 24]) {
        if (start + length > packed.length) break;
        const candidate = packed.slice(start, start + length);
        if (!/^[\x20-\x7e]+$/u.test(candidate)) break;
        const previous = counts.get(candidate);
        if (!previous) counts.set(candidate, { count: 1, end: start + length });
        else if (start >= previous.end) {
          previous.count++;
          previous.end = start + length;
        }
      }
    }
    let best: string | null = null;
    let bestSaving = 0;
    const marker = String.fromCharCode(0x80 + dictionary.length);
    for (const [candidate, { count }] of counts) {
      const entrySize = size(candidate);
      const saving = count * (entrySize - size(marker)) - entrySize - 1;
      if (saving > bestSaving) {
        best = candidate;
        bestSaving = saving;
      }
    }
    if (best === null) break;
    const next = packed.split(best).join(marker);
    if (size([next, [...dictionary, best]]) >= size([packed, dictionary])) break;
    packed = next;
    dictionary.push(best);
  }
  return { packed, dictionary };
}

describe("CSS dictionary packing", () => {
  it("matches position-first selection for ties, overlaps, escaping and Unicode", () => {
    for (const css of [
      "abcd".repeat(16) + "wxyz".repeat(16),
      "abcabcabcabcabcabcabcabcabcabc",
      '"\\\\" abcdefgh '.repeat(12),
      "雪😀" + ".theme { color: red; }".repeat(12) + "雪",
      "short",
    ]) {
      const result = packCss(css);
      expect(result).toEqual(referencePack(css));
      expect(decodeCssDictionary(result.packed, result.dictionary)).toBe(css);
    }
  });

  it("matches the reference across deterministic mixed and repeated fragments", () => {
    const fragments = ["abcd", "abcabc", ' \\" ', "雪", "😀", ".theme { x: y; }"];
    let state = 0x12345678;
    for (let fixture = 0; fixture < 48; fixture++) {
      let css = "";
      for (let i = 0; i < 24; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        css += fragments[state % fragments.length]!;
      }
      const result = packCss(css);
      expect(result).toEqual(referencePack(css));
      expect(decodeCssDictionary(result.packed, result.dictionary)).toBe(css);
    }
  });

  it("returns the last complete state when the unique-candidate limit is reached", () => {
    // The four-digit windows are unique, so the first scan exceeds the map cap.
    const alphabet = "0123456789abcdef";
    const digits = Array<number>(65).fill(0);
    let css = "";
    function sequence(t: number, period: number): void {
      if (t > 4) {
        if (4 % period === 0) {
          for (let i = 1; i <= period; i++) css += alphabet[digits[i]!]!;
        }
        return;
      }
      digits[t] = digits[t - period]!;
      sequence(t + 1, period);
      for (let i = digits[t - period]! + 1; i < alphabet.length; i++) {
        digits[t] = i;
        sequence(t + 1, t);
      }
    }
    sequence(1, 1);
    expect(css).toHaveLength(65_536);
    const result = packCss(css);
    expect(result).toEqual({ packed: css, dictionary: [] });
    expect(decodeCssDictionary(result.packed, result.dictionary)).toBe(css);
  });

  it("keeps the last accepted state when the visit budget cannot cover another round", () => {
    let state = 0x87654321;
    const fragments = Array.from({ length: 40 }, () => {
      let fragment = "";
      for (let i = 0; i < 24; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        fragment += String.fromCharCode(65 + ((state >>> 16) % 26));
      }
      return fragment;
    });
    const css =
      "雪".repeat(90_000) + fragments.map((fragment) => `${fragment}雪`.repeat(8)).join("");
    const budget = { visits: 12_000_000, exhausted: false };
    const expected = referencePack(css, budget);
    expect(budget.exhausted).toBe(true);
    expect(expected.dictionary.length).toBeGreaterThan(0);
    const result = packCss(css);
    expect(result).toEqual(expected);
    expect(decodeCssDictionary(result.packed, result.dictionary)).toBe(css);
  });

  it("accepts the input limit and rejects excess or reserved markers", () => {
    const css = "雪".repeat(100_000);
    expect(packCss(css)).toEqual({ packed: css, dictionary: [] });
    expect(() => packCss(`${css}雪`)).toThrow();
    expect(() => packCss("\u0080")).toThrow();
    expect(() => packCss("Ï")).toThrow();
    expect(packCss("Ð")).toEqual({ packed: "Ð", dictionary: [] });
  });
});

describe("CSS dictionary decoding", () => {
  it("expands markers while preserving Unicode and literal text", () => {
    expect(decodeCssDictionary("\u0080雪😀\u0081\u0080", [".theme", " { color: red }"])).toBe(
      ".theme雪😀 { color: red }.theme",
    );
  });

  it("rejects missing markers and invalid dictionary entries", () => {
    expect(() => decodeCssDictionary("\u0081", ["valid"])).toThrow();
    expect(() => decodeCssDictionary("", ["abc"])).toThrow();
    expect(() => decodeCssDictionary("", ["bad\u0080"])).toThrow();
    expect(() => decodeCssDictionary("", Array(81).fill("valid"))).toThrow();
    expect(decodeCssDictionary("ÏÐ", Array(80).fill("valid"))).toBe("validÐ");
    expect(() => decodeCssDictionary("Ï", Array(79).fill("valid"))).toThrow();
  });

  it("bounds both encoded and decoded lengths", () => {
    expect(() => decodeCssDictionary("x".repeat(100_001), [])).toThrow();
    expect(() => decodeCssDictionary("\u0080".repeat(25_001), ["aaaa"])).toThrow();
    expect(decodeCssDictionary("\u0080".repeat(25_000), ["aaaa"])).toHaveLength(100_000);
  });
});
