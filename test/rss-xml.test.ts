// Pure unit tests for the RSS escape helper: no database, session store or network is contacted.
import { describe, expect, it } from "vitest";
import { rssXml } from "../src/events/rss-xml";

const REPLACEMENT = "\uFFFD";

describe("rssXml", () => {
  it("leaves plain text untouched", () => {
    expect(rssXml("")).toBe("");
    expect(rssXml("hello, world 123")).toBe("hello, world 123");
  });

  it("preserves the legal XML whitespace TAB, LF and CR", () => {
    expect(rssXml("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it.each([
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11, 0x12,
    0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
  ])("replaces forbidden C0 control U+%i with U+FFFD", (cp) => {
    expect(rssXml(`a${String.fromCodePoint(cp)}b`)).toBe(`a${REPLACEMENT}b`);
  });

  it("preserves DEL and C1 controls, which are legal XML characters", () => {
    for (const cp of [0x7f, 0x85, 0x9f]) {
      const value = `a${String.fromCodePoint(cp)}b`;
      expect(rssXml(value)).toBe(value);
    }
  });

  it("replaces each adjacent lone surrogate with its own U+FFFD", () => {
    expect(rssXml(`A${String.fromCharCode(0xd800, 0xdbff)}B`)).toBe(
      `A${REPLACEMENT}${REPLACEMENT}B`,
    );
    expect(rssXml(`A${String.fromCharCode(0xdc00, 0xdfff)}B`)).toBe(
      `A${REPLACEMENT}${REPLACEMENT}B`,
    );
    const reversed = `A${String.fromCharCode(0xdc00)}${String.fromCharCode(0xd83d)}B`;
    expect(rssXml(reversed)).toBe(`A${REPLACEMENT}${REPLACEMENT}B`);
    expect(rssXml(`AB${String.fromCharCode(0xd800)}`)).toBe(`AB${REPLACEMENT}`);
  });

  it("preserves valid surrogate pairs", () => {
    const smile = String.fromCodePoint(0x1f600);
    expect(rssXml(`a${smile}b`)).toBe(`a${smile}b`);
  });

  it("replaces BMP noncharacters U+FFFE and U+FFFF", () => {
    for (const cp of [0xfffe, 0xffff]) {
      const value = `a${String.fromCodePoint(cp)}b`;
      expect(rssXml(value)).toBe(`a${REPLACEMENT}b`);
    }
  });

  it("preserves astral noncharacter pairs as the current sanitizer encodes them", () => {
    // The sanitizer class lists only BMP U+FFFE/U+FFFF, so astral
    // U+1FFFE/U+1FFFF/U+10FFFF pairs pass through; XML 1.0 section 2.2
    // accepts them. Pinned so a future widening shows up here deliberately.
    for (const cp of [0x1fffe, 0x1ffff, 0x10ffff]) {
      const value = `a${String.fromCodePoint(cp)}b`;
      expect(rssXml(value)).toBe(value);
    }
  });

  it("escapes markup with the ENT_QUOTES|ENT_XML1 spelling", () => {
    expect(rssXml('&<>"\u0027')).toBe("&amp;&lt;&gt;&quot;&#039;");
  });

  it("escapes ampersands first so entities are never double-escaped", () => {
    expect(rssXml("&")).toBe("&amp;");
    expect(rssXml("<")).toBe("&lt;");
    expect(rssXml("&lt;")).toBe("&amp;lt;");
    expect(rssXml("&amp;")).toBe("&amp;amp;");
    expect(rssXml("a&b<c")).toBe("a&amp;b&lt;c");
  });
});
