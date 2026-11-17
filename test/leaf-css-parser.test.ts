import { describe, expect, it } from "vitest";
import { parseLeafModule } from "../ci/leaf-css-parser.mjs";

const SHA = "A".repeat(43) + "=";

describe("dictionary-packed module parser", () => {
  const quote = (value: string) => JSON.stringify(value);
  const module = (
    packed: string,
    dictionary: string[],
    { header = "", sha = SHA, tail = "" } = {},
  ) =>
    `${header}import { decodeCssDictionary } from "./css-dictionary";\n` +
    `export const LEAF_CRITICAL_CSS: string =\n  decodeCssDictionary(${quote(packed)}, ${JSON.stringify(dictionary)});\n` +
    `export const LEAF_CRITICAL_CSS_SHA256: string = ${quote(sha)};\n${tail}`;

  it("expands dictionary markers and leaves ordinary text alone", () => {
    expect(parseLeafModule(module("\u0080雪😀\u0081\u0080", ["a { b", " c }"]))).toEqual({
      css: "a { b雪😀 c }a { b",
      sha256: SHA,
    });
    expect(parseLeafModule(module("", []))).toEqual({ css: "", sha256: SHA });
    expect(parseLeafModule(module("\u00d0\u007f", []))).toEqual({
      css: "\u00d0\u007f",
      sha256: SHA,
    });
  });

  it("accepts comment headers and the exact dictionary limits", () => {
    const dictionary = Array.from({ length: 80 }, (_, i) => `e${String(i).padStart(3, "0")}`);
    const packed = Array.from({ length: 80 }, (_, i) => String.fromCharCode(0x80 + i)).join("");
    expect(
      parseLeafModule(module(packed, dictionary, { header: "// GENERATED x\n// y\n" }))?.css,
    ).toBe(dictionary.join(""));
    expect(parseLeafModule(module("x", ["a".repeat(24)]))?.css).toBe("x");
    expect(parseLeafModule(module("x".repeat(100_000), []))?.css).toHaveLength(100_000);
  });

  it.each([
    ["entry shorter than four characters", module("\u0080", ["abc"])],
    ["entry longer than 24 characters", module("\u0080", ["a".repeat(25)])],
    ["non-ASCII entry", module("\u0080", ["abc雪"])],
    ["control character entry", module("\u0080", ["abc\u0007"])],
    ["entry containing a marker", module("\u0080", ["abc\u0081"])],
    [
      "more than 80 entries",
      module(
        "x",
        Array.from({ length: 81 }, () => "abcd"),
      ),
    ],
    ["marker without an entry", module("\u0080", [])],
    ["marker past the last entry", module("\u0081", ["abcd"])],
    ["packed text over 100000 characters", module("x".repeat(100_001), [])],
    ["expansion over 100000 characters", module("\u0080".repeat(4_200), ["a".repeat(24)])],
    ["short hash", module("x", [], { sha: "A".repeat(42) + "=" })],
    ["unpadded hash", module("x", [], { sha: "A".repeat(44) })],
    ["hash with a newline", module("x", [], { sha: `${"A".repeat(42)}\n=` })],
    ["trailing code", module("x", [], { tail: "globalThis.pwned = 1;\n" })],
    ["missing trailing newline", module("x", []).slice(0, -1)],
    ["CRLF line endings", module("x", []).replaceAll("\n", "\r\n")],
    ["extra leading statement", module("x", [], { header: "globalThis.pwned = 1;\n" })],
    ["comment header with CR", module("x", [], { header: "// a\rglobalThis.pwned = 1;\n" })],
    [
      "comment header with U+2028",
      module("x", [], { header: "// a\u2028globalThis.pwned = 1;\n" }),
    ],
    [
      "comment header with U+2029",
      module("x", [], { header: "// a\u2029globalThis.pwned = 1;\n" }),
    ],
    ["different import path", module("x", []).replace("./css-dictionary", "./other")],
    ["different decoder", module("x", []).replace("decodeCssDictionary(", "evil(")],
    ["extra decoder argument", module("x", []).replace("[]);", "[], 1);")],
    ["expression after the call", module("x", []).replace("[]);", "[]) + evil;")],
    ["template literal packed text", module("x", []).replace('"x"', "`x`")],
    ["invalid JSON escape", module("x", []).replace('"x"', '"\\x41"')],
    ["raw newline in packed text", module("x", []).replace('"x"', '"x\ny"')],
    ["unterminated packed text", module("x", []).replace('"x"', '"x')],
    ["non-array dictionary", module("x", []).replace("[]", '"abcd"')],
    ["dictionary with a non-string", module("x", []).replace("[]", "[1]")],
    ["dictionary with spaced commas", module("x", [], {}).replace("[]", '["abcd", "efgh"]')],
    ["both literal and dictionary forms", module("x", []).replace(");\n", ').split("~");\n')],
  ])("rejects %s", (_name, source) => {
    expect(parseLeafModule(source)).toBeNull();
  });

  it("still reads the literal form and rejects a mismatched decoder suffix", () => {
    const literal = (initializer: string) =>
      `export const LEAF_CRITICAL_CSS: string =\n  ${initializer};\nexport const LEAF_CRITICAL_CSS_SHA256: string = ${quote(SHA)};\n`;
    expect(parseLeafModule(literal(quote("a ~ b")))?.css).toBe("a ~ b");
    expect(parseLeafModule(literal(`${quote("a~b")}.split("~").join(".base-theme")`))?.css).toBe(
      "a.base-themeb",
    );
    expect(parseLeafModule(literal(`${quote("a~b")}.split("~").join(".other")`))).toBeNull();
  });
});
