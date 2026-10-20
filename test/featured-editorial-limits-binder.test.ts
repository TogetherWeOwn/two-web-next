// Binder contract for the featured editorial-limits island: the served
// minified bytes count exactly like the server validator (trimmed Unicode
// code points for headline/body/image description, trimmed UTF-16 units for
// the two URLs) and phrase every state with its current count, budget and
// unit. The browser acceptance suites prove the mounted behavior; these pins
// execute the minified output directly so a minify/export regression fails
// fast without Chromium.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";

const source = readFileSync(
  new URL("../public/islands/admin-featured-editorial-limits.js", import.meta.url),
  "utf8",
);
const { featuredCountUsed, featuredCountText } = runInNewContext(
  source.replace(/(^|[;}])export (?=function |const |let |var |class )/gm, "$1") +
    "\n({ featuredCountUsed, featuredCountText });",
  { queueMicrotask },
) as {
  featuredCountUsed: (value: unknown, units: string) => number;
  featuredCountText: (used: number, limit: number, units: string, missingAlt: boolean) => string;
};

describe("featured editorial-limits binder (minified bytes)", () => {
  it.each([
    { label: "ASCII", value: "x".repeat(255), units: "code-points", used: 255 },
    { label: "astral counts once", value: "😀".repeat(128), units: "code-points", used: 128 },
    { label: "astral is 256 UTF-16 units", value: "😀".repeat(128), units: "utf16", used: 256 },
    { label: "combining marks count", value: "é😀", units: "code-points", used: 3 },
    {
      label: "surrounding whitespace trims",
      value: " \t é😀   ",
      units: "code-points",
      used: 3,
    },
    {
      label: "URL trims before counting units",
      value: " \t https://example.test/x   ",
      units: "utf16",
      used: 22,
    },
    { label: "blank trims to zero", value: " \t  ", units: "code-points", used: 0 },
    {
      // 997 + CRLF (2) + 1: the textarea holds one LF, the server sees two.
      label: "line break counts as submitted CRLF",
      value: `${"x".repeat(997)}\nx`,
      units: "code-points",
      used: 1000,
    },
    {
      // 998 + CRLF (2) + 1: over by one as submitted, not "1000 of 1000".
      label: "interior break tips the body over at 1001 submitted",
      value: `${"x".repeat(998)}\nx`,
      units: "code-points",
      used: 1001,
    },
    {
      label: "pre-existing CRLF is not double-expanded",
      value: `${"x".repeat(997)}\r\nx`,
      units: "code-points",
      used: 1000,
    },
    {
      label: "lone CR counts as one submitted break",
      value: `${"x".repeat(997)}\rx`,
      units: "code-points",
      used: 1000,
    },
    {
      label: "breaks count after surrounding whitespace trims",
      value: "  x\ny  ",
      units: "code-points",
      used: 4,
    },
  ])("$label", ({ value, units, used }) => {
    expect(featuredCountUsed(value, units)).toBe(used);
  });

  it("body line-break counts agree with the server verdict on the submitted bytes", () => {
    for (const value of [`${"x".repeat(997)}\nx`, `${"x".repeat(998)}\nx`]) {
      // Browsers serialize textarea LF as CRLF on submit; the counter must
      // match the code points the validator actually sees.
      const submitted = value.trim().replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n");
      expect(featuredCountUsed(value, "code-points")).toBe([...submitted].length);
      let bodyError: string | undefined;
      try {
        parseFeaturedForm({ title: "Game night", body: submitted });
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        bodyError = (error as ValidationError).fields.body;
      }
      expect(featuredCountUsed(value, "code-points") > 1000).toBe(bodyError !== undefined);
    }
  });

  it("states the current count, budget and code-point unit in budget", () => {
    const text = featuredCountText(10, 255, "code-points", false);
    expect(text).toMatch(/\b10\b/);
    expect(text).toMatch(/\b255\b/);
    expect(text).toMatch(/code[ -]?points?/i);
    expect(text).not.toMatch(/over|exceed|too long|too many/i);
  });

  it("states the UTF-16 unit for URL budgets", () => {
    expect(featuredCountText(26, 255, "utf16", false)).toMatch(/UTF[ -]?16/i);
  });

  it("conveys an over-budget state in text, not just color", () => {
    const text = featuredCountText(1001, 1000, "code-points", false);
    expect(text).toMatch(/\b1001\b/);
    expect(text).toMatch(/\b1000\b/);
    expect(text).toMatch(/over|exceed|too long|too many|-[1-9]\d*/i);
  });

  it.each([
    { used: 255, limit: 255, units: "code-points" },
    { used: 1000, limit: 1000, units: "code-points" },
    { used: 255, limit: 255, units: "utf16" },
  ])("at exactly $used of $limit states no over-budget wording", ({ used, limit, units }) => {
    const text = featuredCountText(used, limit, units, false);
    expect(text).toMatch(new RegExp(`\\b${used}\\b`));
    expect(text).toMatch(new RegExp(`\\b${limit}\\b`));
    // No -N alternative: "UTF-16" would false-positive it.
    expect(text).not.toMatch(/over|exceed|too long|too many/i);
  });

  it("one over the limit names a single unit over", () => {
    expect(featuredCountText(256, 255, "code-points", false)).toMatch(/\b1 over the limit\b/);
  });

  it("names a missing image description while an image URL is set", () => {
    expect(featuredCountText(0, 255, "code-points", true)).toMatch(
      /required|missing|describe|description/i,
    );
    expect(featuredCountText(0, 255, "code-points", false)).not.toMatch(
      /required|missing|describe|description/i,
    );
  });
});
