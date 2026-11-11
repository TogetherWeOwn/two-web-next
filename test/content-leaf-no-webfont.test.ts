import { readdirSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";

// Content leaves render the brand display face without a late swap.
// The earliest staging audit found FCP 1687-1750 ms but LCP 2197-2255 ms: the
// swap face arrived after first paint and the largest text block repainted late.
// The content leaves therefore use a content-only 'Mona Sans Content' face with
// font-display: optional over the same woff2, so the display rules paint through
// the shared --font-display token while cold visits keep the metric-matched
// fallback. No font preload ships on the content shell, and no new file is
// requested.
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const rulesOf = (css: string): Array<{ selector: string; body: string }> =>
  (stripComments(css).match(/[^{}]+{[^{}]*}/g) ?? []).map((rule) => ({
    selector: rule.slice(0, rule.indexOf("{")).trim(),
    body: rule.slice(rule.indexOf("{") + 1, -1),
  }));

// A display rule paints through the shared hook. The token definition itself
// (--font-display: ...) is a custom property, not a font declaration, so it is
// never counted as a display rule.
const isDisplayBody = (body: string): boolean =>
  body
    .split(";")
    .some(
      (declaration) =>
        /^\s*font(?:-family)?\s*:/.test(declaration) && declaration.includes("var(--font-display)"),
    );

function displayGuards(css: string): string[] {
  return rulesOf(css)
    .filter((rule) => !/^@font-face/.test(rule.selector) && isDisplayBody(rule.body))
    .filter((rule) => rule.selector.includes(":not(.content-theme)"))
    .map((rule) => rule.selector);
}

function displayRules(css: string): Array<{ selector: string; body: string }> {
  return rulesOf(css).filter(
    (rule) => !/^@font-face/.test(rule.selector) && isDisplayBody(rule.body),
  );
}

const splitSelectors = (selector: string): string[] =>
  selector.split(/,(?![^(]*\))/).map((part) => part.trim());

// Once the content guards are gone the minifier merges the text targets that
// share a declaration, so display coverage is counted per target (selector).
const displayTargets = (css: string): string[] =>
  displayRules(css).flatMap((rule) => splitSelectors(rule.selector));

type FontFace = { family: string; display: string; src: string; body: string };

function fontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  for (const match of stripComments(css).matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1] ?? "";
    const family =
      /font-family\s*:\s*["']?([^;'"]+)["']?\s*;/.exec(body)?.[1]?.trim().replace(/\s+/g, " ") ??
      "";
    const display = /font-display\s*:\s*([a-z-]+)/.exec(body)?.[1] ?? "";
    const src = /src\s*:\s*url\(\s*["']?([^)'"]+?)["']?\s*\)/.exec(body)?.[1]?.trim() ?? "";
    faces.push({ family, display, src, body });
  }
  return faces;
}

function contentTokenValue(css: string): string | null {
  for (const rule of rulesOf(css)) {
    if (!/\.base-theme\.content-theme/.test(rule.selector)) continue;
    const value = /--font-display\s*:\s*([^;{}]+)/.exec(rule.body)?.[1]?.trim() ?? null;
    if (value) return value;
  }
  return null;
}

const normalizeFamily = (value: string): string =>
  value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ");

describe("content leaves use the optional display face", () => {
  it("leaves no :not(.content-theme) guard on any display rule", () => {
    expect(displayTargets(LEAF_CRITICAL_CSS).length).toBeGreaterThanOrEqual(7);
    expect(displayGuards(LEAF_CRITICAL_CSS)).toEqual([]);
  });

  it("flags a guarded display rule as a mutation", () => {
    expect(
      displayGuards(".base-theme:not(.content-theme) h1{font-family:var(--font-display)}"),
    ).toContain(".base-theme:not(.content-theme) h1");
    expect(displayGuards(".base-theme h1{font-family:var(--font-display)}")).toEqual([]);
  });

  it("ships the content face with font-display: optional over the same file as the main face", () => {
    const faces = fontFaces(LEAF_CRITICAL_CSS);
    const main = faces.find((face) => face.family === "Mona Sans");
    const content = faces.find((face) => face.family === "Mona Sans Content");
    expect(main).toBeDefined();
    expect(content).toBeDefined();
    expect(content?.display).toBe("optional");
    expect(content?.src).toBe(main?.src);
    expect(content?.src).toBe("/fonts/mona-sans-latin-var.woff2");
    for (const descriptor of ["font-weight:200900", "font-stretch:75%125%"]) {
      expect(content?.body.replace(/\s+/g, "")).toContain(descriptor);
    }
    for (const descriptor of ["font-weight:200900", "font-stretch:75%125%"]) {
      expect(main?.body.replace(/\s+/g, "")).toContain(descriptor);
    }
    const unicodeOf = (face: FontFace) =>
      /unicode-range\s*:\s*([^;]+)/.exec(face.body)?.[1]?.trim();
    expect(unicodeOf(content!)).toBe(unicodeOf(main!));
  });

  it("routes every stylesheet display reference through the shared token", () => {
    // A rule naming the swap face ('Mona Sans') directly would fetch it on the
    // content pages by itself and bring back the late swap. Literal families
    // may only appear in @font-face blocks and --font-display token values.
    for (const rule of rulesOf(LEAF_CRITICAL_CSS)) {
      if (/^@font-face/.test(rule.selector)) continue;
      for (const declaration of rule.body
        .split(";")
        .map((part) => part.trim())
        .filter((part) => /^(font(?:-family)?|--font-display)\s*:/.test(part))) {
        if (/^--font-display/.test(declaration)) continue;
        expect(declaration).not.toMatch(/Mona Sans(?! Fallback)/);
        expect(declaration).not.toContain("Mona Sans Content");
      }
    }
  });

  it("points the content theme at the content face with the fallback second", () => {
    const value = contentTokenValue(LEAF_CRITICAL_CSS);
    expect(value).not.toBeNull();
    const families = (value ?? "").split(",").map(normalizeFamily);
    expect(families.slice(0, 2)).toEqual(["Mona Sans Content", "Mona Sans Fallback"]);
    expect(families.slice(2)).toContain("system-ui");
  });

  it("ships no new woff2 beyond the Ember set", () => {
    const files = readdirSync(new URL("../public/fonts/", import.meta.url))
      .filter((file) => file.endsWith(".woff2"))
      .sort();
    expect(files).toEqual([
      "fragment-mono-latin-400.woff2",
      "instrument-serif-latin-400-italic.woff2",
      "mona-sans-latin-var.woff2",
    ]);
  });

  it("preloads no font for the content shell but keeps it elsewhere", () => {
    const content = Layout({ title: "Fixture", theme: "content" })!.toString();
    expect(content).not.toContain('.woff2" as="font"');
    for (const theme of ["home", "event", "join", "profile", "schedule"] as const) {
      const html = Layout({ title: "Fixture", theme })!.toString();
      expect(html).toContain('href="/fonts/mona-sans-latin-var.woff2" as="font"');
    }
  });
});
