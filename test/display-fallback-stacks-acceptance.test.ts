import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// Typography acceptance: display text in the four theme sheets reads the
// --two-font-display token (the Lobby Ember chain: Chakra Petch over Display
// over the metric-matched 'Display Fallback'), every font-display token
// definition carries 'Display Fallback' directly after Display, and no
// hardcoded hex lives in theme sheets outside token files. Static pins only:
// no app, no database, no network. A theme swap edits the token value, never
// the sheets; a bare Display family back in a sheet fails here instead of
// forking the stack.

const THEME_SHEETS = [
  "theme.css",
  "event-theme.css",
  "schedule-theme.css",
  "profile-theme.css",
] as const;

const sheet = (entry: string): string =>
  readFileSync(new URL(`../public/${entry}`, import.meta.url), "utf8");

const kitAppCss = (): string =>
  readFileSync(new URL("../web/src/app.css", import.meta.url), "utf8");

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
// @font-face blocks declare families; they are not stacks.
const stripFontFace = (css: string): string => css.replace(/@font-face\s*\{[^}]*\}/g, "");

const FONT_DECLARATION = /(?:font-family|font)\s*:[^;{}]+;/g;
// Bare Display: neither the quoted 'Display Fallback' family nor font-display.
const BARE_DISPLAY = /(?<!['"-\w])Display(?!['"-\w])/;
// Token stacks read the shared chain instead of naming families.
const TOKEN_STACK = /var\(--two-font-display/;
// theme.css position: the fallback sits directly after Display (bare or quoted).
const UNIFIED_STACK = /["']?Display["']?,\s*["']Display Fallback["']/;
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;
const TOKEN_DECLARATION = /--(?:two-)?font-display\s*:[^;{}]+;/g;

const fontDeclarations = (css: string): string[] =>
  stripFontFace(stripComments(css)).match(FONT_DECLARATION) ?? [];

const tokenStacks = (css: string): string[] =>
  fontDeclarations(css).filter((declaration) => TOKEN_STACK.test(declaration));

const tokenDefinitions = (): string[] =>
  [kitAppCss(), sheet("theme-tokens.css"), ...THEME_SHEETS.map(sheet)].flatMap(
    (css) => stripComments(css).match(TOKEN_DECLARATION) ?? [],
  );

describe("unified Display fallback stacks", () => {
  it("reads the display token in every stack, never a bare Display family", () => {
    const violations: string[] = [];
    for (const entry of THEME_SHEETS) {
      for (const stack of fontDeclarations(sheet(entry))) {
        if (BARE_DISPLAY.test(stack)) {
          violations.push(`${entry}: ${stack.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it.each([
    ["theme.css", 7],
    ["event-theme.css", 4],
    ["schedule-theme.css", 1],
    ["profile-theme.css", 4],
  ] as const)("%s carries at least %d token stacks", (entry, minimum) => {
    expect(tokenStacks(sheet(entry)).length).toBeGreaterThanOrEqual(minimum);
  });

  it("finds every token stack (the sweep is not vacuous)", () => {
    const total = THEME_SHEETS.reduce(
      (count, entry) => count + tokenStacks(sheet(entry)).length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(16);
  });
});

describe("--font-display token", () => {
  it("is defined", () => {
    expect(tokenDefinitions().length).toBeGreaterThanOrEqual(1);
  });

  it("carries 'Display Fallback' directly after Display in every definition", () => {
    const violations = tokenDefinitions().filter((declaration) => !UNIFIED_STACK.test(declaration));
    expect(violations).toEqual([]);
  });
});

describe("no hardcoded hex in theme sheets", () => {
  it("carries no hex literal in any theme sheet", () => {
    const violations: string[] = [];
    for (const entry of THEME_SHEETS) {
      const matches = stripComments(sheet(entry)).match(HEX_LITERAL) ?? [];
      for (const hex of matches) {
        violations.push(`${entry}: ${hex}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("derives every .btn:hover rule from the brand token", () => {
    const css = stripComments(sheet("theme.css"));
    const hovers = css.match(/[^{}]*\.btn:hover\s*\{[^}]*\}/g) ?? [];
    expect(hovers.length).toBeGreaterThanOrEqual(1);
    const violations = hovers.filter(
      (rule) => !rule.includes("var(--brand)") || rule.match(/#[0-9a-fA-F]{3,8}\b/) !== null,
    );
    expect(violations).toEqual([]);
  });
});
