// src/media-type.ts quote and escape handling. Request admission
// (isJsonMediaType) and response selection (acceptsJson) share these
// splitters; a quoted parameter value may hold `;`, `,` or an escaped `"`,
// and none of those may end the media type or start a new Accept range.
import { describe, expect, it } from "vitest";
import { acceptsJson, isJsonMediaType, mediaType, splitAcceptRanges } from "../src/media-type";

describe("mediaType quoted parameters", () => {
  it("does not end the type at a semicolon inside quotes", () => {
    expect(mediaType('Application/"JSON;x";charset=utf-8')).toBe('application/"json;x"');
  });

  it("keeps an escaped quote from closing the quoted run", () => {
    expect(mediaType('a/"\\";b";c')).toBe('a/"\\";b"');
  });

  it("treats a backslash outside quotes as a literal", () => {
    expect(mediaType('a/b\\";c";d')).toBe('a/b\\";c"');
  });

  it("refuses quoted lookalikes of application/json", () => {
    expect(isJsonMediaType('application/json";x"')).toBe(false);
    expect(isJsonMediaType('"application/json"')).toBe(false);
    expect(isJsonMediaType(' APPLICATION/JSON ; charset="utf-8"')).toBe(true);
  });
});

describe("splitAcceptRanges quoted parameters", () => {
  it("keeps a comma inside quotes in one range", () => {
    expect(splitAcceptRanges('text/html;q="a,b", text/plain')).toEqual([
      'text/html;q="a,b"',
      " text/plain",
    ]);
  });

  it("keeps an escaped quote from closing the quoted run", () => {
    expect(splitAcceptRanges('a/b;n="\\",c",d/e')).toEqual(['a/b;n="\\",c"', "d/e"]);
  });

  it("treats a backslash outside quotes as a literal", () => {
    expect(splitAcceptRanges("a/b\\,c/d")).toEqual(["a/b\\", "c/d"]);
  });

  it("never selects JSON from inside a quoted parameter with an escaped quote", () => {
    // Without escape handling, `\"` would close the quote and expose the
    // smuggled ` application/json` as its own range.
    expect(acceptsJson('text/html;n="\\", application/json, x="')).toBe(false);
    expect(acceptsJson('text/html;n="\\"", application/json')).toBe(true);
  });
});
