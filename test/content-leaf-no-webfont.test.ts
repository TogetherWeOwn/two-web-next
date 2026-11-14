import { readdirSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const rulesOf = (css: string): Array<{ selector: string; body: string }> =>
  (stripComments(css).match(/[^{}]+{[^{}]*}/g) ?? []).map((rule) => ({
    selector: rule.slice(0, rule.indexOf("{")).trim(),
    body: rule.slice(rule.indexOf("{") + 1, -1),
  }));

// A display rule paints through the shared hook; the token definition itself
// (--font-display: ...) is a custom property, not a font declaration.
const isDisplayBody = (body: string): boolean =>
  body
    .split(";")
    .some((declaration) => /font(?:-family)?\s*:[^;{}]*var\(--font-display\)/.test(declaration));

const displayRules = (css: string): Array<{ selector: string; body: string }> =>
  rulesOf(css).filter((rule) => !/^@font-face/.test(rule.selector) && isDisplayBody(rule.body));

const guardsOf = (css: string): string[] =>
  displayRules(css)
    .filter((rule) => rule.selector.includes(":not(.content-theme)"))
    .map((rule) => rule.selector);

// Counted per target: the minifier merges targets sharing a declaration.
const displayTargets = (css: string): string[] =>
  displayRules(css).flatMap((rule) =>
    rule.selector.split(/,(?![^(]*\))/).map((part) => part.trim()),
  );

type FontFace = { family: string; src: string; body: string };

function fontFaces(css: string): FontFace[] {
  return [...stripComments(css).matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => {
    const body = match[1] ?? "";
    return {
      family:
        /font-family\s*:\s*["']?([^;'"]+)["']?\s*;/.exec(body)?.[1]?.trim().replace(/\s+/g, " ") ??
        "",
      src: /src\s*:\s*url\(\s*["']?([^)'"]+?)["']?\s*\)/.exec(body)?.[1]?.trim() ?? "",
      body,
    };
  });
}

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

  it("flags a guarded display rule as a mutation", () => {
    expect(
      guardsOf(".base-theme:not(.content-theme) h1{font-family:var(--font-display)}"),
    ).toContain(".base-theme:not(.content-theme) h1");
    expect(guardsOf(".base-theme h1{font-family:var(--font-display)}")).toEqual([]);
    expect(
      displayTargets(".base-theme h1,.base-theme h2{font-family:var(--font-display)}"),
    ).toEqual([".base-theme h1", ".base-theme h2"]);
  });

  it("ships the content face with font-display: optional over the same file as the main face", () => {
    const faces = fontFaces(LEAF_CRITICAL_CSS);
    const main = faces.find((face) => face.family === "Mona Sans");
    const content = faces.find((face) => face.family === "Mona Sans Content");
    expect(main).toBeDefined();
    expect(content).toBeDefined();
    const optional = /(?:^|;)\s*font-display\s*:\s*optional\s*(?:;|$)/;
    expect(content?.body).toMatch(optional);
    expect("font-display:optionalfoo;").not.toMatch(optional);
    expect(content?.src).toBe(main?.src);
    expect(content?.src).toBe("/fonts/mona-sans-latin-wght.woff2");
    for (const descriptor of ["font-weight:200900"]) {
      expect(content?.body.replace(/\s+/g, "")).toContain(descriptor);
      expect(main?.body.replace(/\s+/g, "")).toContain(descriptor);
    }
    const unicodeOf = (face: FontFace) =>
      /unicode-range\s*:\s*([^;]+)/.exec(face.body)?.[1]?.trim();
    expect(unicodeOf(content!)).toBe(unicodeOf(main!));
  });

  it("routes every stylesheet display reference through the shared token", () => {
    // A literal 'Mona Sans' family outside @font-face blocks and token values
    // would fetch the swap face on the content pages and bring back the late
    // swap; literal families may only appear in those two places.
    const declarations = rulesOf(LEAF_CRITICAL_CSS).flatMap((rule) =>
      /^@font-face/.test(rule.selector)
        ? []
        : rule.body
            .split(";")
            .map((part) => part.trim())
            .filter((part) => /^(font(?:-family)?|--font-display)\s*:/.test(part)),
    );
    for (const declaration of declarations) {
      if (/^--font-display/.test(declaration)) continue;
      expect(declaration).not.toMatch(/Mona Sans(?! Fallback)/);
      expect(declaration).not.toContain("Mona Sans Content");
    }
  });

  it("ships no new woff2 beyond the Ember set", () => {
    const files = readdirSync(new URL("../public/fonts/", import.meta.url))
      .filter((file) => file.endsWith(".woff2"))
      .sort();
    expect(files).toEqual([
      "fragment-mono-latin-400.woff2",
      "instrument-serif-latin-400-italic.woff2",
      "mona-sans-latin-var.woff2",
      "mona-sans-latin-wght.woff2",
    ]);
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
