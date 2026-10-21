// Theme one-file swap acceptance: the Logo 1 theme ships as the default in
// ONE file, every stray colour reads semantic tokens, the docs describe the
// contract, and a throwaway alternate theme proves the single-switch swap.
// Test-Author-owned: the Builder implements against this file and never
// edits it.
//
// Contract source is the brand kit (BRAND-SYSTEM.md): section 6 names the
// semantic tokens and the apply plan, section 2 fixes the Logo 1 values,
// section 1 lists every hard-coded colour to consolidate. These tests fail
// on the pre-swap tree (lime/charcoal defaults, stray fallbacks, missing
// alternate) and pass only after the swap. Hermetic: file reads plus
// offline route renders. No database, no network.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";
import {
  GRADIENT_STOPS,
  KIT_LOBBY_VALUES,
  STALE_THEME_VALUES,
  THEME_CONTRACT,
  THEME_PINK,
  VARIANT_PLUGS,
  colourRegexInsensitive,
  discoverAlternateTheme,
  formatFindings,
  lookupVar,
  parseCustomProperties,
  stripCommentsAndEntities,
  sweepColourLiterals,
} from "./theme-acceptance-helpers";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");
const fileExists = (rel: string): boolean => existsSync(join(repoRoot, rel));

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
};

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("theme acceptance tests must stay offline");
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const themeVars = (): Map<string, string[]> =>
  parseCustomProperties(read("public/theme-tokens.css"));

function gradientInOrder(value: string, stops: string[]): boolean {
  const lower = value.toLowerCase();
  let from = 0;
  for (const stop of stops) {
    const at = lower.indexOf(stop, from);
    if (at < 0) {
      return false;
    }
    from = at + stop.length;
  }
  return true;
}

function fontFace(value: string): string {
  return value.trim().replace(/^["']/, "").toLowerCase();
}

describe("theme contract: one default file", () => {
  it("defines every contract token in public/theme-tokens.css", () => {
    const vars = themeVars();
    const missing = THEME_CONTRACT.filter((token) => lookupVar(vars, token.vars) === undefined).map(
      (token) => `${token.key} (${token.vars.join(" or ")})`,
    );
    expect(missing).toEqual([]);
  });

  it("carries the Logo 1 values for the solid tokens", () => {
    const vars = themeVars();
    const problems: string[] = [];
    for (const token of [...THEME_CONTRACT, THEME_PINK]) {
      if (
        token.key === "gradient-brand" ||
        token.key === "gradient-brand-h" ||
        token.key === "display-font" ||
        token.key === "body-font"
      ) {
        continue;
      }
      const actual = lookupVar(vars, token.vars);
      if (actual === undefined) {
        problems.push(`${token.key}: missing`);
      } else if (actual.toLowerCase() !== token.value.toLowerCase()) {
        problems.push(`${token.key}: expected ${token.value}, saw ${actual}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("follows the icon vector for gradients and the brand faces for type", () => {
    const vars = themeVars();
    const brand = lookupVar(vars, ["--theme-gradient-brand"]) ?? "";
    expect(brand.toLowerCase()).toContain("180deg");
    expect(brand).toContain("52.12%");
    expect(gradientInOrder(brand, GRADIENT_STOPS)).toBe(true);
    const horizontal = lookupVar(vars, ["--theme-gradient-brand-h"]) ?? "";
    expect(horizontal.toLowerCase()).toContain("90deg");
    expect(horizontal).toContain("52.12%");
    expect(gradientInOrder(horizontal, [...GRADIENT_STOPS].reverse())).toBe(true);
    const display = lookupVar(vars, ["--two-font-display", "--theme-display-font"]) ?? "";
    expect(fontFace(display).startsWith("chakra petch")).toBe(true);
    const body = lookupVar(vars, ["--two-font-body", "--theme-body-font"]) ?? "";
    expect(fontFace(body).startsWith("inter")).toBe(true);
  });

  it("re-plugs the seven base semantics in the schedule variant", () => {
    const vars = themeVars();
    const problems: string[] = [];
    for (const plug of VARIANT_PLUGS) {
      const name = `--theme-schedule-${plug.suffix}`;
      const values = vars.get(name) ?? [];
      if (values.length === 0) {
        problems.push(`${name}: missing`);
      } else if ((values[0] ?? "").toLowerCase() !== plug.value.toLowerCase()) {
        problems.push(`${name}: expected ${plug.value}, saw ${values[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("does not duplicate the contract across Hono sheets", () => {
    const alternate = discoverAlternateTheme(repoRoot);
    const sheets = readdirSync(join(repoRoot, "public")).filter((entry) => entry.endsWith(".css"));
    const definers = sheets.filter((entry) => {
      const rel = `public/${entry}`;
      if (alternate !== null && alternate.path === rel) {
        return false;
      }
      return parseCustomProperties(read(rel)).has("--theme-text");
    });
    for (const definer of definers) {
      expect(definer).toBe("theme-tokens.css");
    }
  });

  it("keeps --theme-* definitions out of components", () => {
    const alternate = discoverAlternateTheme(repoRoot);
    const allowed = new Set([
      "public/theme-tokens.css",
      "web/src/app.css",
      "src/leaf-critical-css.ts",
    ]);
    if (alternate !== null) {
      allowed.add(alternate.path);
    }
    const roots = ["src", "web/src"];
    const offenders: string[] = [];
    for (const root of roots) {
      const files = readdirSync(join(repoRoot, root), { recursive: true }).map(String);
      for (const entry of files) {
        const rel = `${root}/${entry}`;
        if (allowed.has(rel)) {
          continue;
        }
        if (!/\.(ts|tsx|js|mjs|svelte|css|html)$/.test(entry)) {
          continue;
        }
        const text = read(rel);
        if (/--[a-zA-Z0-9-]*theme-[a-zA-Z0-9-]*\s*:/.test(text)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("Kit mirror", () => {
  it("carries the Logo 1 lobby values with no stale defaults", () => {
    const vars = parseCustomProperties(read("web/src/app.css"));
    const problems: string[] = [];
    for (const [name, value] of Object.entries(KIT_LOBBY_VALUES)) {
      const actual = lookupVar(vars, [name]);
      if (actual === undefined) {
        problems.push(`${name}: missing`);
      } else if (actual.toLowerCase() !== value.toLowerCase()) {
        problems.push(`${name}: expected ${value}, saw ${actual}`);
      }
    }
    for (const [name, values] of vars) {
      if (!name.startsWith("--color-lobby-") && !name.startsWith("--theme-")) {
        continue;
      }
      for (const value of values) {
        const hexes = value.toLowerCase().match(/#[0-9a-f]{3,8}\b/g) ?? [];
        for (const hex of hexes) {
          if (STALE_THEME_VALUES.has(hex)) {
            problems.push(`${name}: stale default ${hex}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("plugs the full contract in .base-theme", () => {
    const vars = parseCustomProperties(read("web/src/app.css"));
    const missing = THEME_CONTRACT.filter((token) => lookupVar(vars, token.vars) === undefined).map(
      (token) => token.key,
    );
    expect(missing).toEqual([]);
  });
});

describe("stray colours consolidated", () => {
  it("leaves no colour literal outside the theme files", () => {
    const allow = new Set([
      "public/theme-tokens.css",
      "web/src/app.css",
      // Legacy unthemed shell: out of scope per brand-kit section 1.
      "public/styles.css",
      "assets/styles.css",
      // Generated bundle: derivation is pinned by the leaf test below.
      "src/leaf-critical-css.ts",
    ]);
    const alternate = discoverAlternateTheme(repoRoot);
    if (alternate !== null) {
      allow.add(alternate.path);
    }
    const findings = sweepColourLiterals(repoRoot, allow);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  it("serves the fallback shell in theme values", () => {
    const headers = read("src/headers.ts").toLowerCase();
    for (const hex of ["#141117", "#f7f7f7", "#ff9c36"]) {
      expect(headers).toContain(hex);
    }
    for (const hex of ["#121719", "#f5f5eb", "#c2f45b"]) {
      expect(headers).not.toContain(hex);
    }
  });

  it("keeps the catastrophic template in theme values", () => {
    const template = read("web/src/error.html").toLowerCase();
    for (const hex of ["#141117", "#f7f7f7", "#ff9c36"]) {
      expect(template).toContain(hex);
    }
    for (const hex of ["#121719", "#f5f5eb", "#c2f45b"]) {
      expect(template).not.toContain(hex);
    }
  });

  it("points theme-color and the manifest at the page token", () => {
    expect(read("src/page-shell.tsx")).toContain('theme-color" content="#141117"');
    expect(read("web/src/app.html")).toContain('theme-color" content="#141117"');
    const manifest = JSON.parse(read("public/site.webmanifest")) as {
      background_color: string;
      theme_color: string;
    };
    expect(manifest.background_color).toBe("#141117");
    expect(manifest.theme_color).toBe("#141117");
  });

  it("serves theme-color and install links on pages", async () => {
    for (const path of ["/", "/about"]) {
      const response = await app.request(path, {}, env);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<meta name="theme-color" content="#141117"');
      expect(html).toContain('<link rel="manifest" href="/site.webmanifest"');
    }
  });

  it("brands the header with the Logo 1 lockup", async () => {
    const response = await app.request("/", {}, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("/logo.svg");
    expect(html).toContain("lockup-horizontal");
    const publicFiles = readdirSync(join(repoRoot, "public"), { recursive: true }).map(String);
    expect(publicFiles.some((entry) => entry.endsWith("lockup-horizontal.svg"))).toBe(true);
  });

  it("ships the Logo 1 favicon first with PNG fallback", async () => {
    const publicFiles = readdirSync(join(repoRoot, "public"), { recursive: true }).map(String);
    const favicon = publicFiles.find((entry) => entry.endsWith("favicon.svg"));
    expect(favicon).toBeDefined();
    if (favicon === undefined) {
      return;
    }
    const svg = read(`public/${favicon}`).toLowerCase();
    for (const stop of GRADIENT_STOPS) {
      expect(svg).toContain(stop);
    }
    const response = await app.request("/", {}, env);
    const html = await response.text();
    const svgLink = html.search(/<link[^>]*rel="icon"[^>]*favicon\.svg[^>]*>/);
    const pngLink = html.search(/<link[^>]*rel="icon"[^>]*\.png[^>]*>/);
    expect(svgLink).toBeGreaterThanOrEqual(0);
    expect(pngLink).toBeGreaterThanOrEqual(0);
    expect(svgLink).toBeLessThan(pngLink);
  });

  it("wires social images to the brand card", async () => {
    const image = `${env.APP_URL}/og-1200x630.png`;
    const response = await app.request("/", {}, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<meta property="og:image" content="${image}"`);
    expect(html).toContain(`<meta name="twitter:image" content="${image}"`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(read("web/src/lib/SiteMetadata.svelte")).toContain("og:image");
    const png = join(repoRoot, "public/og-1200x630.png");
    expect(existsSync(png)).toBe(true);
    if (!existsSync(png)) {
      return;
    }
    const magic = readFileSync(png).subarray(0, 8);
    expect(
      Buffer.from(magic).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);
  });

  it("derives the leaf bundle from the theme file at build time", () => {
    expect(read("ci/build-leaf-css.mjs")).toContain("theme-tokens.css");
    const bundle = LEAF_CRITICAL_CSS.toLowerCase();
    expect(bundle).toContain("#ff9c36");
    expect(bundle).toContain("#141117");
    expect(bundle).not.toContain("#a3ff12");
    expect(bundle).not.toContain("#151720");
  });

  it("retires the temporary-mark generator", () => {
    if (!fileExists("ci/generate-icons.py")) {
      return;
    }
    const script = read("ci/generate-icons.py");
    expect(script).not.toMatch(/temporary TWO wordmark/i);
    expect(script).toMatch(/retir|repoint|supersed|lockup|Logo 1/i);
  });

  it("self-hosts the brand faces", () => {
    const vars = themeVars();
    const display = lookupVar(vars, ["--two-font-display", "--theme-display-font"]) ?? "";
    expect(fontFace(display).startsWith("chakra petch")).toBe(true);
    const body = lookupVar(vars, ["--two-font-body", "--theme-body-font"]) ?? "";
    expect(fontFace(body).startsWith("inter")).toBe(true);
    const fonts = readdirSync(join(repoRoot, "public/fonts")).map(String);
    expect(fonts.some((entry) => /chakra/i.test(entry) && entry.endsWith(".woff2"))).toBe(true);
    expect(fonts.some((entry) => /inter/i.test(entry) && entry.endsWith(".woff2"))).toBe(true);
    const license = read("public/fonts/LICENSE.txt");
    expect(license).toMatch(/chakra petch/i);
    expect(license).toMatch(/inter/i);
    expect(license).toMatch(/ofl/i);
  });
});

describe("docs: theme contract", () => {
  it("documents the contract and the one-file swap on the homepage theme", () => {
    const text = read("docs/home-theme.md");
    const missing = THEME_CONTRACT.filter(
      (token) => !token.vars.some((name) => text.includes(name)),
    ).map((token) => token.key);
    expect(missing).toEqual([]);
    expect(text).toContain("--theme-schedule-accent");
    expect(text).toMatch(/how to add a theme|adding a (new )?theme/i);
    expect(text).toMatch(/one file|single-file|data-theme|one import/i);
  });

  it("documents the contract and the one-file swap on the event theme", () => {
    const text = read("docs/event-theme.md");
    const varHits = THEME_CONTRACT.filter((token) =>
      token.vars.some((name) => text.includes(name)),
    ).length;
    const hasFullList = varHits >= 15;
    const hasPointer =
      text.includes("home-theme.md") && /theme contract/i.test(text) && varHits >= 3;
    expect(hasFullList || hasPointer).toBe(true);
    expect(text).toMatch(/how to add a theme|adding a (new )?theme/i);
    expect(text).toMatch(/one file|single-file|data-theme|one import/i);
  });

  it("names the shipped brand set in the assets paragraph", () => {
    const text = read("docs/home-theme.md");
    expect(text).toContain("lockup-horizontal");
    expect(text).toContain("favicon.svg");
    expect(text).toContain("og-1200x630");
    expect(text).not.toMatch(/temporary TWO wordmark/i);
  });
});

describe("one-file swap proof", () => {
  it("ships a throwaway alternate theme that is not the default", () => {
    const alternate = discoverAlternateTheme(repoRoot);
    expect(
      alternate,
      "expected a throwaway alternate theme (for example high-contrast) in public/*.css " +
        "or test/fixtures/**/*.css defining the contract with differing values",
    ).not.toBeNull();
    if (alternate === null) {
      return;
    }
    expect(read("public/theme-tokens.css").toLowerCase()).toContain("#ff9c36");
  });

  it("flips the effective tokens through the single hook", async () => {
    const alternate = discoverAlternateTheme(repoRoot);
    expect(alternate).not.toBeNull();
    if (alternate === null) {
      return;
    }
    const vars = themeVars();
    const missingDefault = THEME_CONTRACT.filter(
      (token) => lookupVar(vars, token.vars) === undefined,
    ).map((token) => token.key);
    expect(missingDefault).toEqual([]);
    const missingAlternate = THEME_CONTRACT.filter(
      (token) => lookupVar(alternate.vars, token.vars) === undefined,
    ).map((token) => token.key);
    expect(missingAlternate).toEqual([]);
    const defaultAccent = (lookupVar(vars, ["--theme-accent"]) ?? "").toLowerCase();
    const alternateAccent = (lookupVar(alternate.vars, ["--theme-accent"]) ?? "").toLowerCase();
    expect(defaultAccent).not.toBe("");
    expect(alternateAccent).not.toBe("");
    expect(alternateAccent).not.toBe(defaultAccent);
    if (alternate.mechanism === "drop-in") {
      const shell = Layout({ title: "Fixture", theme: "event" })!.toString() as string;
      expect(shell.match(/href="\/theme-tokens\.css"/g)).toHaveLength(1);
      expect(read("public/theme.css")).toContain("var(--");
    } else {
      expect(alternate.attribute).not.toBeNull();
      expect(read("docs/home-theme.md")).toContain(`data-theme="${alternate.attribute}`);
      expect(read("public/theme-tokens.css")).not.toContain(`[data-theme="${alternate.attribute}"`);
    }
  });

  it("keeps serving Logo 1 while the alternate exists", async () => {
    const alternate = discoverAlternateTheme(repoRoot);
    expect(alternate).not.toBeNull();
    if (alternate === null) {
      return;
    }
    const response = await app.request("/", {}, env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<meta name="theme-color" content="#141117"');
    expect(html.toLowerCase()).toContain("#ff9c36");
    const vars = themeVars();
    for (const token of THEME_CONTRACT) {
      const baseline = lookupVar(vars, token.vars);
      const shifted = lookupVar(alternate.vars, token.vars);
      if (baseline === undefined || shifted === undefined) {
        continue;
      }
      if (/^#[0-9a-f]{6}$/i.test(shifted) && shifted.toLowerCase() !== baseline.toLowerCase()) {
        expect(html.toLowerCase()).not.toContain(shifted.toLowerCase());
        return;
      }
    }
  });
});

describe("consolidation controls", () => {
  it("keeps the authored theme sheets literal-free", () => {
    for (const sheet of [
      "public/theme.css",
      "public/event-theme.css",
      "public/profile-theme.css",
      "public/schedule-theme.css",
    ]) {
      const clean = stripCommentsAndEntities(read(sheet));
      const hits = clean.match(colourRegexInsensitive()) ?? [];
      expect(hits, sheet).toEqual([]);
    }
  });

  it("keeps hex colours out of Svelte components", () => {
    const entries = readdirSync(join(repoRoot, "web/src"), { recursive: true }).map(String);
    const problems: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".svelte")) {
        continue;
      }
      const clean = stripCommentsAndEntities(read(`web/src/${entry}`));
      const hits = clean.match(colourRegexInsensitive()) ?? [];
      if (hits.length > 0) {
        problems.push(`${entry}: ${hits.join(", ")}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
