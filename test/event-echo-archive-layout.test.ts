// Event Echo archive row layout: a long frozen headline must wrap inside the
// attendance column instead of squeezing the minmax(0,1fr) info column down
// to one character per line (caught in 1280x800 screenshots: the Echo card's
// title and meta stacked vertically while the record line took the row).
// Static CSS pin only: no app, no database, no network.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

const sheet = (): string =>
  readFileSync(new URL("../public/schedule-theme.css", import.meta.url), "utf8");

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const attendanceRule = (): string => {
  const match = stripComments(sheet()).match(/\.events-page\s+\.schedule-attendance\s*\{[^}]*\}/);
  if (!match) throw new Error("schedule-attendance rule missing");
  return match[0];
};

describe("echo archive row layout", () => {
  it("clamps the attendance column so a long Echo headline wraps in place", () => {
    const rule = attendanceRule();
    expect(rule).toMatch(/max-width\s*:\s*\d/);
    expect(rule).toMatch(/min-width\s*:\s*0/);
    expect(rule).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });

  it("keeps the info column fluid above the clamp", () => {
    const css = stripComments(sheet());
    expect(css).toMatch(/\.schedule-row\s*\{[^}]*minmax\(0,\s*1fr\)/);
  });
});
