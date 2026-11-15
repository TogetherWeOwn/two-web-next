import { describe, expect, it } from "vitest";
import { decodeCssDictionary } from "../src/css-dictionary";

describe("CSS dictionary decoding", () => {
  it("expands markers while preserving Unicode and literal text", () => {
    expect(decodeCssDictionary("\u0080雪😀\u0081\u0080", [".theme", " { color: red }"])).toBe(
      ".theme雪😀 { color: red }.theme",
    );
    expect(decodeCssDictionary("", [])).toBe("");
    expect(decodeCssDictionary("\u007fÐ", [])).toBe("\u007fÐ");
  });

  it("rejects missing markers and invalid dictionary entries", () => {
    expect(() => decodeCssDictionary("\u0081", ["valid"])).toThrow();
    expect(() => decodeCssDictionary("", ["abc"])).toThrow();
    expect(() => decodeCssDictionary("", ["a".repeat(25)])).toThrow();
    expect(() => decodeCssDictionary("", ["bad\u0080"])).toThrow();
    expect(() => decodeCssDictionary("", ["bad\n"])).toThrow();
    expect(() => decodeCssDictionary("", Array(81).fill("valid"))).toThrow();
    expect(decodeCssDictionary("ÏÐ", Array(80).fill("valid"))).toBe("validÐ");
    expect(() => decodeCssDictionary("Ï", Array(79).fill("valid"))).toThrow();
    expect(decodeCssDictionary("\u0080\u0081", ["aaaa", "x".repeat(24)])).toBe(
      `aaaa${"x".repeat(24)}`,
    );
  });

  it("bounds both encoded and decoded lengths in UTF-16 code units", () => {
    expect(decodeCssDictionary("x".repeat(100_000), [])).toHaveLength(100_000);
    expect(() => decodeCssDictionary("x".repeat(100_001), [])).toThrow();
    expect(() => decodeCssDictionary("\u0080".repeat(25_001), ["aaaa"])).toThrow();
    expect(decodeCssDictionary("\u0080".repeat(25_000), ["aaaa"])).toHaveLength(100_000);
    expect(() => decodeCssDictionary(`${"😀".repeat(50_000)}x`, [])).toThrow();
  });
});
