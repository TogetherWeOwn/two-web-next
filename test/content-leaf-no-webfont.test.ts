import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";

function inspectWebfontRules(css: string) {
  const offenders: string[] = [];
  let inspected = 0;
  // Definitions alone never paint text. Inspect actual font declarations,
  // including variable references, without counting custom-property values.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+{[^{}]*}/g) ?? [];
  for (const rule of rules) {
    const selector = rule.slice(0, rule.indexOf("{")).trim();
    if (/^@font-face/.test(selector)) continue;
    const declarations = rule.slice(rule.indexOf("{") + 1, -1).split(";");
    if (
      !declarations.some((declaration) =>
        /^\s*font(?:-family)?\s*:[^;]*(?:Mona Sans|var\(--font-(?:display|ui)\))/.test(declaration),
      )
    )
      continue;
    inspected += 1;
    if (selector.split(/,(?![^(]*\))/).some((part) => !/:not\(\.content-theme\)/.test(part)))
      offenders.push(selector);
  }
  return { offenders, inspected };
}

// A late webfont swap previously pushed content-leaf mobile LCP over 2000ms.
// Content leaves retain system text, including body, headings and controls.
describe("content leaves render without webfonts", () => {
  it("scopes every UI/display text rule away from the content theme", () => {
    const result = inspectWebfontRules(LEAF_CRITICAL_CSS);
    expect(result.inspected).toBeGreaterThan(0);
    expect(result.offenders).toEqual([]);
  });

  it("detects unscoped family, alias and shorthand mutations", () => {
    for (const font of [
      "font-family:Mona Sans",
      'font-family:"Mona Sans"',
      "font-family:var(--font-display)",
      "font:16px/1.55 var(--font-ui)",
    ]) {
      const css = `${LEAF_CRITICAL_CSS}.base-theme h1{${font}}`;
      expect(inspectWebfontRules(css).offenders).toContain(".base-theme h1");
    }
    expect(
      inspectWebfontRules(
        ".base-theme:not(.content-theme) h1,.base-theme h2{font-family:var(--font-ui)}",
      ).offenders,
    ).toHaveLength(1);
  });

  it("ignores font registrations and unused custom-property definitions", () => {
    expect(
      inspectWebfontRules(
        '@font-face{font-family:"Mona Sans";src:url(font.woff2)}.base-theme{--font-ui:Mona Sans;}',
      ),
    ).toEqual({ offenders: [], inspected: 0 });
  });

  it("preloads no font for the content shell but keeps it elsewhere", () => {
    const content = Layout({ title: "Fixture", theme: "content" })!.toString();
    expect(content).not.toContain('.woff2" as="font"');
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const html = Layout({ title: "Fixture", theme })!.toString();
      expect(html).toContain('href="/fonts/mona-sans-latin-wght.woff2" as="font"');
    }
  });
});
