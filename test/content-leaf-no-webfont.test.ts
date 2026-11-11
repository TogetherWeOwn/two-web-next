import { readdirSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";

// Content leaves render the brand display face without a late swap: staging
// measured FCP 1687-1750 ms but LCP 2197-2255 ms while the swap face arrived.
// A content-only 'Mona Sans Content' face with font-display: optional over the
// same woff2 paints through the shared --font-display token; no preload, no
// new file.
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

function contentTokenValue(css: string): string | null {
  const rule = rulesOf(css).find((rule) => /\.base-theme\.content-theme/.test(rule.selector));
  return /--font-display\s*:\s*([^;{}]+)/.exec(rule?.body ?? "")?.[1]?.trim() ?? null;
}

const normalizeFamily = (value: string): string =>
  value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ");

describe("content leaves use the optional display face", () => {
  it("leaves no :not(.content-theme) guard on any display rule", () => {
    expect(displayTargets(LEAF_CRITICAL_CSS).length).toBeGreaterThanOrEqual(7);
    expect(guardsOf(LEAF_CRITICAL_CSS)).toEqual([]);
  });

  it("flags a guarded display rule as a mutation", () => {
    expect(
      guardsOf(".base-theme:not(.content-theme) h1{font-family:var(--font-display)}"),
    ).toContain(".base-theme:not(.content-theme) h1");
    expect(guardsOf(".base-theme h1{font-family:var(--font-display)}")).toEqual([]);
  });

  it("ships the content face with font-display: optional over the same file as the main face", () => {
    const faces = fontFaces(LEAF_CRITICAL_CSS);
    const main = faces.find((face) => face.family === "Mona Sans");
    const content = faces.find((face) => face.family === "Mona Sans Content");
    expect(main).toBeDefined();
    expect(content).toBeDefined();
    expect(content?.body.replace(/\s+/g, "")).toContain("font-display:optional");
    expect(content?.src).toBe(main?.src);
    expect(content?.src).toBe("/fonts/mona-sans-latin-var.woff2");
    for (const descriptor of ["font-weight:200900", "font-stretch:75%125%"]) {
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
