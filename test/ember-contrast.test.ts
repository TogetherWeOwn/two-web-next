import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Ember Hours contrast acceptance (two-design-kit v0.2.0, tokens §1.8).
// The pairs below are read out of public/theme-tokens.css itself, so the
// test verifies the sheet's actual pairs with independent WCAG 2.x relative
// luminance math -- not the kit's published ratios. Full declared table:
// the kit's docs/tokens.md §1.8 at the pinned tag. Static pins only:
// no app, no database, no network.

// sRGB channel to linear.
function channel(hex: string, offset: number): number {
  const v = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function ratio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const tokensCss = readFileSync(new URL("../public/theme-tokens.css", import.meta.url), "utf8");

function tokenDefault(name: string): string {
  // First occurrence is the .base-theme default; the schedule block repeats it.
  const match = tokensCss.match(
    new RegExp(`${name}:\\s*var\\(--theme[a-z-]*,\\s*(#[0-9a-fA-F]{6})\\)`),
  );
  expect(match, `theme-tokens.css still defines ${name} as a hooked kit literal`).not.toBeNull();
  return match![1]!.toLowerCase();
}

const text = () => tokenDefault("--color-text");
const page = () => tokenDefault("--color-page");
const accent = () => tokenDefault("--color-accent");
const muted = () => tokenDefault("--color-muted");
const surface = () => tokenDefault("--color-surface");
const border = () => tokenDefault("--color-border");

describe("ember text pairs meet WCAG AA on their grounds", () => {
  it.each([
    ["body text on page", text, page],
    ["body text on card surface", text, surface],
    ["muted copy on page", muted, page],
    ["muted copy on card surface", muted, surface],
    ["ember links on page", accent, page],
    ["page-ink label on the ember primary button", page, accent],
  ] as const)("%s is at least 4.5:1", (_label, fg, bg) => {
    expect(ratio(fg(), bg())).toBeGreaterThanOrEqual(4.5);
  });

  it("control border is at least 3:1 on the page", () => {
    expect(ratio(border(), page())).toBeGreaterThanOrEqual(3);
  });
});

describe("echo violet is never a text colour", () => {
  // Kit rule (tokens §1.5): echo violet (#9d6aff) is 4.27:1 on overlay and
  // under 4.5:1, so Echo tags sit on grounds 0-2 only -- never as text on
  // overlay, and this migration introduces no echo text at all.
  const roots = ["../public", "../assets", "../web/src"] as const;

  function* cssLike(): Generator<{ file: string; css: string }> {
    for (const root of roots) {
      const dir = fileURLToPath(new URL(`${root}/`, import.meta.url));
      for (const name of readdirSync(dir, { recursive: true }) as string[]) {
        if (!/\.(css|svelte)$/.test(name)) continue;
        const full = join(dir, name);
        try {
          if (!statSync(full).isFile()) continue;
        } catch {
          continue;
        }
        yield { file: `${root}/${name}`, css: readFileSync(full, "utf8") };
      }
    }
  }

  it("uses no echo violet literal as a color value", () => {
    const violations: string[] = [];
    for (const { file, css } of cssLike()) {
      const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of clean.matchAll(/color\s*:[^;{}]+;/gi)) {
        if (/#9d6aff/i.test(match[0])) violations.push(`${file}: ${match[0].trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("references no echo kit variable as a color value", () => {
    const violations: string[] = [];
    for (const { file, css } of cssLike()) {
      const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of clean.matchAll(/color\s*:[^;{}]+;/gi)) {
        if (/--two-color-(state-)?echo/.test(match[0]))
          violations.push(`${file}: ${match[0].trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
