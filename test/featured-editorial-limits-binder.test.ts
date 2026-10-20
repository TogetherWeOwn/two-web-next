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
  ])("$label", ({ value, units, used }) => {
    expect(featuredCountUsed(value, units)).toBe(used);
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

  it("names a missing image description while an image URL is set", () => {
    expect(featuredCountText(0, 255, "code-points", true)).toMatch(
      /required|missing|describe|description/i,
    );
    expect(featuredCountText(0, 255, "code-points", false)).not.toMatch(
      /required|missing|describe|description/i,
    );
  });
});
