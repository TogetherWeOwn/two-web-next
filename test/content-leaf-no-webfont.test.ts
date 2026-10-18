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
    // itself. Everything else that names Display must stay off the content
    // theme — including ::marker, which does trigger a font fetch.
    const rules = LEAF_CRITICAL_CSS.match(/[^{}]+{[^{}]*}/g) ?? [];
    for (const rule of rules) {
      const selector = rule.slice(0, rule.indexOf("{"));
      const declarations = rule.slice(rule.indexOf("{"));
      if (!/Display/.test(declarations)) continue;
      const selectorWithoutComments = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (/^@font-face/.test(selectorWithoutComments)) continue;
      if (!/:not\(\.content-theme\)/.test(selector)) offenders.push(selector.trim());
    }
    expect(offenders).toEqual([]);
  });

  it("preloads no font for the content shell but keeps it elsewhere", () => {
    const content = Layout({ title: "Fixture", theme: "content" })!.toString();
    expect(content).not.toContain('.woff2" as="font"');
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const html = Layout({ title: "Fixture", theme })!.toString();
      expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
    }
  });
});
