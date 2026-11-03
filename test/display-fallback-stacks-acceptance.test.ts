import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// Typography acceptance: every Rajdhani Display stack in the four theme sheets
// carries the metric-matched 'Display Fallback' directly after Display (the
// theme.css position), every --font-display token definition names the
// self-hosted Space Grotesk face (design §3.2) with a swap @font-face, and no
// hardcoded hex lives in theme sheets outside token files. Static pins only:
// no app, no database, no network.

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
// theme.css position: the fallback sits directly after Display.
const UNIFIED_STACK = /Display,\s*["']Display Fallback["']/;
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;
const TOKEN_DECLARATION = /--font-display\s*:[^;{}]+;/g;

const displayStacks = (css: string): string[] =>
  (stripFontFace(stripComments(css)).match(FONT_DECLARATION) ?? []).filter((declaration) =>
    BARE_DISPLAY.test(declaration),
  );

const tokenDefinitions = (): string[] =>
  [kitAppCss(), sheet("theme-tokens.css"), ...THEME_SHEETS.map(sheet)].flatMap(
    (css) => stripComments(css).match(TOKEN_DECLARATION) ?? [],
  );

describe("unified Display fallback stacks", () => {
  it("carries 'Display Fallback' directly after Display in every stack", () => {
    const violations: string[] = [];
    for (const entry of THEME_SHEETS) {
      for (const stack of displayStacks(sheet(entry))) {
        if (!UNIFIED_STACK.test(stack)) {
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
  ] as const)("%s carries at least %d unified stacks", (entry, minimum) => {
    const unified = displayStacks(sheet(entry)).filter((stack) => UNIFIED_STACK.test(stack));
    expect(unified.length).toBeGreaterThanOrEqual(minimum);
  });

  it("finds every Display stack (the sweep is not vacuous)", () => {
    const total = THEME_SHEETS.reduce(
      (count, entry) => count + displayStacks(sheet(entry)).length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(16);
  });
});

describe("--font-display token", () => {
  it("is defined in both token layers", () => {
    expect(tokenDefinitions().length).toBeGreaterThanOrEqual(2);
  });

  // Token migration (design §3.2, §3.7): the display role is the self-hosted
  // Space Grotesk face. Rajdhani Display stacks keep the metric-matched
  // 'Display Fallback' until the last surface using them migrates (enforced
  // above); the Space Grotesk stacks do not name Display at all, so they
  // cannot carry that fallback. Metric-tuned local fallbacks for the new
  // faces land with their first painted usage (later Living Lobby card),
  // measured then — no unverifiable overrides are declared here.
  it("names the self-hosted Space Grotesk face in every definition", () => {
    const violations = tokenDefinitions().filter(
      (declaration) => !declaration.includes("Space Grotesk"),
    );
    expect(violations).toEqual([]);
  });

  it("declares a swap @font-face for every named display family", () => {
    const faces = stripComments(sheet("theme.css")).match(/@font-face\s*\{[^}]*\}/g) ?? [];
    const violations: string[] = [];
    for (const family of ["Space Grotesk"]) {
      const face = faces.filter((block) => block.includes(`"${family}"`));
      if (face.length === 0) violations.push(`${family}: no @font-face`);
      for (const block of face) {
        if (!/font-display\s*:\s*swap/.test(block)) violations.push(`${family}: no swap`);
      }
    }
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
