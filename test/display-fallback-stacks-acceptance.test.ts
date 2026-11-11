import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";

// Typography acceptance: every Mona Sans stack in the four theme sheets
// carries the metric-matched 'Mona Sans Fallback' directly after Mona Sans
// (the theme.css position), every --font-display token definition carries the
// fallback too (including the content-theme override, which carries 'Mona Sans
// Content' first with the fallback second, and the generated
// web/src/ember-theme.css; exactness against the vendored kit is gated by
// ci/check-ember-token-sync.mjs), and no hardcoded hex lives in theme rules
// outside the generated base role block.
// theme.css is generated and minified: its display text rules use the shared
// --font-display hook, which is expanded here so the stack counts still pin
// the real family chain. Static pins only: no app, no database, no network.

const THEME_SHEETS = [
  "theme.css",
  "event-theme.css",
  "schedule-theme.css",
  "profile-theme.css",
] as const;

const sheet = (entry: string): string =>
  readFileSync(new URL(`../public/${entry}`, import.meta.url), "utf8");

const authoredThemeCss = (): string =>
  readFileSync(new URL("../assets/theme.css", import.meta.url), "utf8");

const emberThemeCss = (): string =>
  readFileSync(new URL("../web/src/ember-theme.css", import.meta.url), "utf8");

const kitAppCss = (): string =>
  readFileSync(new URL("../web/src/app.css", import.meta.url), "utf8");

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
// @font-face blocks declare families; they are not stacks.
const stripFontFace = (css: string): string => css.replace(/@font-face\s*\{[^}]*\}/g, "");

const FONT_DECLARATION = /(?:font-family|font)\s*:[^;{}]+(?:;|(?=\}))/g;
// Bare Mona Sans: neither the quoted 'Mona Sans Fallback' family nor font-display.
const BARE_MONA = /(?<!['"-\w])Mona Sans(?!['"-\w])/;
// theme.css position: the fallback sits directly after Mona Sans.
const UNIFIED_STACK = /Mona Sans["']?,\s*["']Mona Sans Fallback["']/;
// Content position: the fallback sits directly after Mona Sans Content.
const UNIFIED_CONTENT_STACK = /Mona Sans Content["']?,\s*["']Mona Sans Fallback["']/;
const UNIFIED_STACK_OR_CONTENT =
  /(?:Mona Sans Content["']?|Mona Sans["']?),\s*["']Mona Sans Fallback["']/;
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;
const TOKEN_DECLARATION = /--font-display\s*:[^;{}]+(?:;|(?=\}))/g;

const tokenValue = (declaration: string): string =>
  declaration.replace(/^--font-display\s*:\s*/, "").replace(/;$/, "");

const tokenDefinitions = (): string[] =>
  [kitAppCss(), emberThemeCss(), sheet("theme-tokens.css"), ...THEME_SHEETS.map(sheet)].flatMap(
    (css) => stripComments(css).match(TOKEN_DECLARATION) ?? [],
  );

// The served hook value every var(--font-display) usage resolves to is the
// base definition; the content-theme override re-points the same hook at the
// optional content face, so it is read separately below.
const hookValue = (): string => {
  const definitions = stripComments(sheet("theme.css")).match(TOKEN_DECLARATION) ?? [];
  expect(definitions.length).toBeGreaterThanOrEqual(1);
  return tokenValue(definitions[0]!);
};

const hookDefinitions = (): string[] =>
  stripComments(sheet("theme.css")).match(TOKEN_DECLARATION) ?? [];

const contentHookValue = (): string => {
  const override = hookDefinitions().find((definition) =>
    UNIFIED_CONTENT_STACK.test(tokenValue(definition)),
  );
  expect(override, "theme.css must define a content-theme --font-display override").toBeDefined();
  return tokenValue(override!);
};

// Declarations that resolve to a Mona Sans stack: literal stacks plus usages
// of the shared hook, expanded to the stack they resolve to. Counted per
// declaration occurrence: once the content guards are gone the minifier merges
// the text targets sharing `font-family: var(--font-display)` into one rule,
// so the pinned counts below drop by one with no target lost.
const displayStacks = (css: string): string[] => {
  const hook = hookValue();
  return (stripFontFace(stripComments(css)).match(FONT_DECLARATION) ?? [])
    .map((declaration) => declaration.replace(/var\(--font-display\)/g, hook))
    .filter((declaration) => BARE_MONA.test(declaration));
};

describe("unified Mona Sans fallback stacks", () => {
  it("carries 'Mona Sans Fallback' directly after Mona Sans in every stack", () => {
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

  // theme.css drops one declaration because the minifier merges the text
  // targets that share `font-family: var(--font-display)` once the content
  // guards are gone; all eight targets still paint through the hook (see the
  // per-target pin in test/content-leaf-no-webfont.test.ts).
  it.each([
    ["theme.css", 6],
    ["event-theme.css", 4],
    ["schedule-theme.css", 1],
    ["profile-theme.css", 4],
  ] as const)("%s carries at least %d unified stacks", (entry, minimum) => {
    const unified = displayStacks(sheet(entry)).filter((stack) => UNIFIED_STACK.test(stack));
    expect(unified.length).toBeGreaterThanOrEqual(minimum);
  });

  it("finds every Mona Sans stack (the sweep is not vacuous)", () => {
    const total = THEME_SHEETS.reduce(
      (count, entry) => count + displayStacks(sheet(entry)).length,
      0,
    );
    // 15, not 16, for the same minifier merge as the theme.css count above.
    expect(total).toBeGreaterThanOrEqual(15);
  });
});

describe("--font-display token", () => {
  it("is defined", () => {
    expect(tokenDefinitions().length).toBeGreaterThanOrEqual(1);
  });

  it("carries the kit family and the local fallback in every definition", () => {
    // The hook is the kit literal plus the measured local fallback, inserted
    // by the generator; ci/check-ember-token-sync.mjs fails on any drift. A
    // definition without the fallback would swap to unadjusted system sans.
    // The content-theme override carries the content face instead, with the
    // same fallback second.
    for (const definition of tokenDefinitions()) {
      expect(definition).toMatch(UNIFIED_STACK_OR_CONTENT);
    }
  });

  it("is defined in both the served theme.css and the generated Kit sheet", () => {
    expect(stripComments(sheet("theme.css")).match(TOKEN_DECLARATION)).toHaveLength(2);
    expect(stripComments(emberThemeCss()).match(TOKEN_DECLARATION)).toHaveLength(1);
  });

  it("points the content-theme override at the content face with the fallback second", () => {
    const families = contentHookValue()
      .split(",")
      .map((family) =>
        family
          .trim()
          .replace(/^["']|["']$/g, "")
          .replace(/\s+/g, " "),
      );
    expect(families.slice(0, 2)).toEqual(["Mona Sans Content", "Mona Sans Fallback"]);
    expect(families.slice(2)).toContain("system-ui");
    const definitions = hookDefinitions();
    expect(
      definitions.filter((definition) => UNIFIED_CONTENT_STACK.test(tokenValue(definition))),
    ).toHaveLength(1);
    expect(
      definitions.filter((definition) => UNIFIED_STACK.test(tokenValue(definition))),
    ).toHaveLength(1);
  });

  it("is used by the shared display rules in theme.css (six usages after the minifier merge)", () => {
    const usages = stripFontFace(stripComments(sheet("theme.css"))).match(
      /(?:font-family|font)\s*:[^;{}]*var\(--font-display\)/g,
    );
    expect(usages?.length ?? 0).toBeGreaterThanOrEqual(6);
  });
});

describe("no hardcoded hex in theme sheets", () => {
  // public/theme.css leads with the consumed generated font/motion roles,
  // followed by the minified authored sheet. The generated block's exactness
  // and consumer-driven role selection are gated separately.
  const GENERATED_ROLE_BLOCK =
    /^\.base-theme\{[^{}]*\}@media\(prefers-reduced-motion:reduce\)\{\.base-theme\{[^{}]*\}\}/;

  it("carries no hex literal in the authored theme.css", () => {
    expect(stripComments(authoredThemeCss()).match(HEX_LITERAL) ?? []).toEqual([]);
  });

  it("carries no hex literal in any served theme sheet outside the generated role block", () => {
    const served = stripComments(sheet("theme.css"));
    const block = served.match(GENERATED_ROLE_BLOCK);
    expect(block).not.toBeNull();
    expect(block?.[0]).toContain("--font-display:");
    expect(block?.[0]).toContain("--font-ui:var(--font-display)");
    expect(block?.[0]).toContain("--motion-duration-base:.16s");
    expect(block?.[0]).toContain("--motion-duration-base:0ms");
    expect(block?.[0].match(HEX_LITERAL) ?? []).toEqual([]);
    const violations: string[] = [];
    for (const hex of served.replace(GENERATED_ROLE_BLOCK, "").match(HEX_LITERAL) ?? []) {
      violations.push(`theme.css: ${hex}`);
    }
    for (const entry of THEME_SHEETS.filter((name) => name !== "theme.css")) {
      for (const hex of stripComments(sheet(entry)).match(HEX_LITERAL) ?? []) {
        violations.push(`${entry}: ${hex}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("derives primary and account-button hover states from their semantic roles", () => {
    const css = stripComments(sheet("theme.css"));
    const hovers = css.match(/[^{}]*\.btn:hover\s*\{[^}]*\}/g) ?? [];
    expect(hovers).toHaveLength(2);
    for (const rule of hovers) {
      expect(rule.match(HEX_LITERAL) ?? []).toEqual([]);
      if (rule.includes(".header-account")) {
        expect(rule).toContain("background:var(--surface)");
        expect(rule).toContain("border-color:var(--brand)");
        expect(rule).toContain("color:var(--brand)");
      } else {
        expect(rule).toContain("background:var(--accent-hi)");
        expect(rule).toContain("color:var(--on-accent)");
        expect(rule).not.toContain("filter:");
      }
    }
  });
});
