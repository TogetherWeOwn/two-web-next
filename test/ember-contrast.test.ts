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

describe("echo violet text stays on an accessible ground", () => {
  // Kit tokens §1.5 prohibit Echo tags on overlay; §1.8 pairs echo violet
  // with an opaque echo-bg for AA text. Only the Tag rule may use that pair.
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

  function echoTextReferences(css: string): string[] {
    // A space preserves token boundaries.
    const clean = css.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, " ");
    const references = [...clean.matchAll(/(?<![\w-])color\s*:[^;{}]+;/gi)]
      .filter((match) =>
        /--two-color-(state-)?echo|var\(\s*--(?:color-)?echo\s*[,)]/.test(match[0]),
      )
      .map((match) => match[0].trim());
    for (const match of clean.matchAll(
      /(?<![\w:-])class(?::text-echo(?![\w-])|\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}))/g,
    )) {
      if (/(?<![\w-])text-echo(?![\w-])/.test(match[0])) references.push(match[0]);
    }
    return references;
  }

  it("detects emitted echo variables and Svelte text utilities without flagging backgrounds", () => {
    for (const css of [
      "a{color:var(--echo);}",
      "a{color:var( --color-echo , red);}",
      "a{color:var(--two-color-echo);}",
      "a{color:var(--two-color-state-echo);}",
      '<p class="text-echo">Echo</p>',
      "<p class='hover:text-echo/80'>Echo</p>",
      '<p class={active ? "text-echo" : "text-t1"}>Echo</p>',
      "<p class:text-echo={active}>Echo</p>",
      '<p<!-- x -->class="text-echo">Echo</p>',
      "a{z:1/**/color:var(--echo);}",
    ]) {
      expect(echoTextReferences(css), css).not.toEqual([]);
    }
    for (const css of [
      "a{color:var(--echo-bg);}",
      "a{background-color:var(--echo);}",
      "a{--echo:#9d6aff;--color-echo:#9d6aff;}",
      '<p class="bg-echo text-echo-bg">Tag</p>',
      "/* a{color:var(--echo);} */",
      '<!-- <p class="text-echo">Echo</p> -->',
    ]) {
      expect(echoTextReferences(css), css).toEqual([]);
    }
  });

  function disallowedEchoText(file: string, css: string): string[] {
    // Admit only this exact rule, with no competing declarations inside it.
    const safeTagRule =
      /(?:^|})\s*\.echo\s*\{\s*color:\s*var\(--echo\);\s*background:\s*var\(--echo-bg\);\s*box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--echo\) 50%, transparent\);\s*\}/g;
    const clean = css.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, " ");
    const rules = [...clean.matchAll(safeTagRule)];
    const checked =
      file === "../web/src/lib/Tag.svelte" && rules.length === 1
        ? clean.replace(safeTagRule, " ")
        : clean;
    return echoTextReferences(checked);
  }

  it("rejects missing and translucent fills, including in Tag", () => {
    const file = "../web/src/lib/Tag.svelte";
    for (const fill of [
      "",
      "background:rgba(38,28,60,.5);",
      "background:color-mix(in srgb, var(--echo-bg), transparent);",
    ]) {
      expect(disallowedEchoText(file, `.echo { color:var(--echo); ${fill} }`)).not.toEqual([]);
    }
    const safe =
      ".echo { color: var(--echo); background: var(--echo-bg); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--echo) 50%, transparent); }";
    expect(disallowedEchoText(file, safe)).toEqual([]);
    expect(disallowedEchoText("../assets/example.css", safe)).not.toEqual([]);
    expect(disallowedEchoText(file, `${safe} a{color:var(--echo);}`)).not.toEqual([]);
  });

  it("checks the generated Echo pair against AA", () => {
    const theme = readFileSync(new URL("../web/src/ember-theme.css", import.meta.url), "utf8");
    const echo = theme.match(/--echo:(#[0-9a-f]{6})[;}]/i)?.[1];
    const background = theme.match(/--echo-bg:(#[0-9a-f]{6})[;}]/i)?.[1];
    expect(echo).toBeDefined();
    expect(background).toBeDefined();
    expect(ratio(echo!, background!)).toBeGreaterThanOrEqual(4.5);
  });

  it("references echo text only in the filled Tag rule", () => {
    const violations: string[] = [];
    for (const { file, css } of cssLike()) {
      for (const reference of disallowedEchoText(file, css)) {
        violations.push(`${file}: ${reference}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
