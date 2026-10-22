import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";

// Staging mobile LCP on /about, /faq, /rules and /privacy measured
// 2197–2255 ms against the 2000 ms budget while FCP sat at 1687–1750 ms. The
// LCP breakdown shows a ~350–1200 ms render delay after a healthy TTFB: the
// Display webfont arrives after first paint and its swap re-lays-out the
// whole leaf, so the largest text block repaints ~500 ms late and becomes
// LCP. Content leaves therefore use no webfont at all: headings, navigation
// and buttons render in the system stack on the first paint, and no font is
// preloaded for them. Other themes keep Display.
describe("content leaves render without the Display webfont", () => {
  it("scopes every Display text rule away from the content theme", () => {
    const offenders: string[] = [];
    // Split the bundle into selector/declaration pairs; @font-face only
    // ships the file (other themes use it) and can never paint text by
    // itself, and neither can a custom-property DEFINITION (:root --two-*
    // tokens name the Display fallback in the stack value without using
    // it). Everything else that names a webfont must stay off the content
    // theme — including ::marker, which does trigger a font fetch.
    //
    // The brand stacks live behind --two-font-display/--two-font-body, so
    // matching the "Display" literal alone is blind to every token use: the
    // scan flags the token references and the Chakra Petch/Inter faces too.
    const webfontPattern = /Display|Chakra Petch|\bInter\b|--two-font-display|--two-font-body/;
    // Unscoped .base-theme font rules in bundle order. The theme-tokens sheet
    // sets the Inter body font on bare .base-theme and the LATER theme.css
    // rule resets it to the system stack at equal specificity, so content
    // leaves (which match bare .base-theme) keep the system stack only while
    // both rules exist in this order. Pinned explicitly below: any other
    // unscoped .base-theme font rule breaks the cascade shape and fails.
    const baseThemeFontRules: string[] = [];
    const rules = LEAF_CRITICAL_CSS.match(/[^{}]+{[^{}]*}/g) ?? [];
    for (const rule of rules) {
      const selector = rule.slice(0, rule.indexOf("{"));
      const declarations = rule.slice(rule.indexOf("{"));
      const selectorWithoutComments = selector
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (/^@font-face/.test(selectorWithoutComments)) continue;
      const pairs = declarations
        .slice(1, -1)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
      if (pairs.length > 0 && pairs.every((pair) => /^--[a-z0-9-]+\s*:/i.test(pair))) continue;
      if (
        selectorWithoutComments === ".base-theme" &&
        pairs.some((pair) => /^font(-family)?\s*:/i.test(pair))
      ) {
        baseThemeFontRules.push(rule.replace(/\s+/g, " ").trim());
        continue;
      }
      if (!webfontPattern.test(declarations)) continue;
      if (!/:not\(\.content-theme\)/.test(selector)) offenders.push(selector.trim());
    }
    expect(offenders).toEqual([]);
    // The pinned cascade: theme-tokens.css sets the token body font first,
    // theme.css resets it to the system stack second. A third rule (for
    // example the theme.css Inter rule with its :not(.content-theme) dropped)
    // or a swapped order fails here instead of silently reintroducing a
    // webfont fetch on /about, /faq, /rules and /privacy.
    expect(
      baseThemeFontRules,
      "unscoped .base-theme font cascade must stay [tokens rule, system-ui reset]",
    ).toHaveLength(2);
    expect(baseThemeFontRules[0]).toContain("var(--two-font-body");
    expect(baseThemeFontRules[1]).toContain("system-ui");
    expect(baseThemeFontRules[1]).not.toMatch(webfontPattern);
  });

  it("preloads no font for the content shell but keeps it elsewhere", () => {
    const content = Layout({ title: "Fixture", theme: "content" })!.toString();
    expect(content).not.toContain('.woff2" as="font"');
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const html = Layout({ title: "Fixture", theme })!.toString();
      expect(html).toContain('href="/fonts/chakra-petch-latin-700-normal.woff2" as="font"');
    }
  });
});
