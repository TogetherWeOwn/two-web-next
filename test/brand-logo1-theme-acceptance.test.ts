// route-inventory: GET /
// Acceptance: brand — apply the Logo 1 ("Lobby Ember") theme to the
// current Open Lobby layout (tokens, header lockup, fonts, favicon/manifest/OG).
//
// Spec: BRAND-SYSTEM.md + tokens.css + assets/ from two-brand-kit.zip
// (issue attachment, sha256 4c0c8235d4993e03378c59a239b2a9bd3ba2a3240ebd515ca7a015ceb37ef31b;
// brand anchors #FF9C36 -> #FF0E52 at 52.12% -> #5701AE).
//
// FROZEN FILE: the Builder builds on this card's branch and never edits this
// file. A correction here needs a new Test-Author run, not a
// builder edit.
//
// Hermetic by design: no database (only GET / plus scratch error handlers),
// no network, no staging. Kit components are SSR-compiled with the web
// workspace's own svelte/compiler (same harness as
// test/kit-content-no-webfont.test.ts). RED on Open Lobby; GREEN after the
// BRAND-SYSTEM §6 apply. Staging-only checks (computed styles, axe, the
// 1440/390 before/after screenshots) are Builder PR evidence, not this file.
//
// Deliberate omissions (spec-silent or staging-only):
// - skip-link ink on accent: §6 names only the .btn flip; not pinned here.
// - mobile icon-only 40px header: covered by the required 390px screenshots.
// - "at most one gradient moment per viewport": a viewport property; the
//   source-level guards below (no gradient body text/buttons/backgrounds)
//   plus staging screenshots cover it.
// - hero side details ("clip-art chevrons" in the card): the brand-kit
//   preview-desktop.png target look KEEPS them re-tinted in gradient stops,
//   per §5 ("re-tint ... keeps the Open Lobby composition") and the no-layout-
//   changes criterion (§6). This file pins their presence (layout preserved)
//   and lets the token swap re-tint them; removal would contradict the kit.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { Hono } from "hono";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { maintenanceHandler, notFoundHandler } from "../src/errors";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const APP_URL = "https://next.example.test";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// ---------------------------------------------------------------------------
// WCAG 2.1 relative-luminance math (same definition BRAND-SYSTEM §2 computed
// its contrast table with). Recomputed here so the table is verified, not
// trusted.
// ---------------------------------------------------------------------------
function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const f = (i: number) => {
    const v = Number.parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
}

function contrast(fg: string, bg: string): number {
  const [hi = 0, lo = 0] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// theme-tokens.css values: --theme-<name>: #rrggbb (the §6 drop-in sets the
// plugs directly; the schedule variant re-plugs --theme-schedule-<name>).
function themeTokens(): Map<string, string> {
  const css = read("public/theme-tokens.css");
  const out = new Map<string, string>();
  for (const m of css.matchAll(/--theme-([a-z-]+):\s*#([0-9a-fA-F]{6})/g)) {
    const name = m[1];
    const hex = m[2];
    if (name && hex) out.set(name, `#${hex}`.toLowerCase());
  }
  return out;
}

// PNG dimensions from the IHDR chunk (no image dependency).
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(Buffer.from(bytes.subarray(0, 8)).equals(magic)).toBe(true);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

// Text-file sweep. Lockfiles are excluded: their hashes are content-addressed
// and unfixable by a theme swap. Everything else tracked-or-untracked counts:
// "no longer appears anywhere" means anywhere.
const TEXT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
  ".svelte",
  ".json",
  ".md",
  ".py",
  ".svg",
  ".xml",
  ".txt",
  ".webmanifest",
  ".yml",
  ".yaml",
  ".toml",
  ".jsonc",
]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".paperclip",
  ".svelte-kit",
  "test-results",
  "coverage",
  "dist",
  "playwright-report",
  ".wrangler",
  "build",
]);
const SELF = "test/brand-logo1-theme-acceptance.test.ts";

function sweepText(pattern: RegExp, relDirs: string[] = ["."]): string[] {
  const hits: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel === "." ? entry.name : `${rel}/${entry.name}`;
      if (relPath === SELF || relPath.endsWith("package-lock.json")) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), relPath);
      } else if (TEXT_EXTS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        const body = readFileSync(join(dir, entry.name), "utf8");
        if (pattern.test(body)) hits.push(relPath);
        pattern.lastIndex = 0;
      }
    }
  };
  for (const d of relDirs) walk(join(root, d), d);
  return hits.sort();
}

function headerSlice(html: string): string {
  const start = html.indexOf("<header");
  const end = html.indexOf("</header>");
  expect(start, "page carries a <header>").toBeGreaterThanOrEqual(0);
  expect(end, "page closes its </header>").toBeGreaterThan(start);
  return html.slice(start, end);
}

function svgOpenTag(header: string): string | null {
  const m = header.match(/<svg[^>]*>/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Kit SSR harness: the real SiteHeader + SiteMetadata, compiled with the web
// workspace's svelte/compiler and bundled by esbuild (same shape as
// test/kit-content-no-webfont.test.ts).
// ---------------------------------------------------------------------------
type Theme = "home" | "event" | "content" | "join" | "profile" | "schedule";

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

async function buildKitBrandBundle(): Promise<{
  renderHeader: (props: Record<string, never>) => string;
  renderMeta: (props: {
    title: string;
    theme: Theme;
    canonical?: string;
    description?: string | null;
  }) => string;
}> {
  const scratch = mkdtempSync(join(tmpdir(), "kit-brand-"));
  try {
    const entry = join(scratch, "kit-brand-entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Header from ${JSON.stringify(join(root, "web/src/lib/SiteHeader.svelte"))};
import Meta from ${JSON.stringify(join(root, "web/src/lib/SiteMetadata.svelte"))};
export function renderHeader(props) {
  const { body } = render(Header, { props });
  return body;
}
export function renderMeta(props) {
  const { head, body } = render(Meta, { props });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "kit-brand.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      plugins: [
        {
          name: "kit-brand-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
                generate: "server",
                dev: false,
                filename: args.path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
            });
          },
        },
      ],
    });
    return (await import(pathToFileURL(outfile).href)) as {
      renderHeader: (props: Record<string, never>) => string;
      renderMeta: (props: {
        title: string;
        theme: Theme;
        canonical?: string;
        description?: string | null;
      }) => string;
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function scratchErrors() {
  const scratchApp = new Hono();
  scratchApp.notFound((c) => notFoundHandler(c));
  scratchApp.get("/down", maintenanceHandler("https://discord.gg/invite"));
  return scratchApp;
}

// One Kit bundle for the whole file: the renders below are pure functions of
// the checked-in .svelte sources.
let kit: Awaited<ReturnType<typeof buildKitBrandBundle>>;
beforeAll(async () => {
  kit = await buildKitBrandBundle();
}, 120_000);

// Lockup geometry from assets/lockup-horizontal.svg (456.86 x 126.34).
const LOCKUP_RATIO = 456.86 / 126.34;

describe("Open Lobby layout preserved (BRAND-SYSTEM §6: theme only, no layout changes)", () => {
  it("keeps the home hero copy byte for byte", async () => {
    const html = await (await app.request("/", {}, env)).text();
    expect(html).toContain("A close-knit gaming clan / mostly evenings / 18+");
    expect(html).toContain('<h1 id="home-heading">The lobby is open.</h1>');
    expect(html).toContain("We spent most of our life private. Now you can just turn up.");
  });

  it("keeps the home chrome: nav, hero side details, CTAs, footer leaves", async () => {
    const html = await (await app.request("/", {}, env)).text();
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain('href="/" aria-current="page"');
    expect(html).toContain('href="/events"');
    expect(html).toContain('class="hero-detail hero-detail-left"');
    expect(html).toContain('class="hero-detail hero-detail-right"');
    expect(html).toContain("Join with Discord");
    expect(html).toContain("Sign in with Discord");
    for (const leaf of ["/about", "/faq", "/rules", "/privacy"]) {
      expect(html, `footer keeps ${leaf}`).toContain(`href="${leaf}"`);
    }
  });

  it("keeps the Kit header chrome: nav, guest account, skip link", async () => {
    const html = kit.renderHeader({});
    expect(html).toContain('aria-label="Primary"');
    expect(html).toContain("Home");
    expect(html).toContain("Events");
    expect(html).toContain("Welcome, guest");
    expect(html).toContain("Sign in with Discord");
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('aria-label="Together We Own homepage"');
  });
});

describe("brand tokens (BRAND-SYSTEM §2, tokens.css)", () => {
  const EXPECTED: Record<string, string> = {
    text: "#f7f7f7",
    page: "#141117",
    accent: "#ff9c36",
    "accent-ink": "#1d0b00",
    muted: "#bdb7d1",
    surface: "#1e1a25",
    raised: "#272133",
    border: "#3c344c",
    focus: "#ff9c36",
    link: "#ffa94d",
    violet: "#5701ae",
    "violet-deep": "#3a0086",
    pink: "#ff0e52",
    success: "#3ddc84",
    warn: "#ffb020",
    danger: "#ff6b8a",
  };

  it("theme-tokens.css carries the §2 semantic contract", () => {
    const tokens = themeTokens();
    for (const [name, hex] of Object.entries(EXPECTED)) {
      expect(tokens.get(name), `--theme-${name}`).toBe(hex);
    }
  });

  it("theme-tokens.css defines both brand gradients with the §2 stops", () => {
    const css = read("public/theme-tokens.css").toLowerCase();
    expect(css).toContain("--theme-gradient-brand:");
    expect(css).toContain("--theme-gradient-brand-h:");
    for (const stop of ["#ff9c36", "#ff0e52", "#5701ae"]) {
      expect(css, `gradient stop ${stop}`).toContain(stop);
    }
    expect(css).toContain("52.12%");
  });

  it("the schedule variant re-plugs the same brand values", () => {
    const css = read("public/theme-tokens.css").toLowerCase();
    for (const [name, hex] of Object.entries({
      "schedule-text": "#f7f7f7",
      "schedule-page": "#141117",
      "schedule-accent": "#ff9c36",
      "schedule-accent-ink": "#1d0b00",
      "schedule-muted": "#bdb7d1",
      "schedule-surface": "#1e1a25",
      "schedule-raised": "#272133",
      "schedule-border": "#3c344c",
    })) {
      expect(css, `--theme-${name}`).toContain(`--theme-${name}: ${hex}`);
    }
  });

  it("the Kit @theme mirror in web/src/app.css carries the same brand values", () => {
    const css = read("web/src/app.css").toLowerCase();
    for (const [token, hex] of Object.entries({
      "--color-lobby-surface": "#141117",
      "--color-lobby-raised": "#1e1a25",
      "--color-lobby-ink": "#f7f7f7",
      "--color-lobby-muted": "#bdb7d1",
      "--color-lobby-accent": "#ff9c36",
      "--color-lobby-on-accent": "#1d0b00",
      "--color-lobby-line": "#3c344c",
      "--color-lobby-focus": "#ff9c36",
    })) {
      expect(css, `${token}`).toContain(`${token}: ${hex}`);
    }
  });

  it("the regen'd leaf bundle carries the new tokens, not the old lime", () => {
    const leaf = LEAF_CRITICAL_CSS.toLowerCase();
    expect(leaf).toContain("#ff9c36");
    expect(leaf).toContain("#141117");
    expect(leaf).not.toContain("#a3ff12");
    expect(leaf).not.toContain("#c2f45b");
    expect(leaf).not.toContain("#151720");
  });

  it("lime #c2f45b no longer appears anywhere", () => {
    expect(sweepText(/c2f45b/i)).toEqual([]);
  });

  it("legacy lime #a3ff12 is gone from the token/asset/source paths", () => {
    expect(sweepText(/a3ff12/i, ["public", "src", "web/src"])).toEqual([]);
  });

  it("the rendered homepage carries new tokens and none of the old Hono set", async () => {
    const html = (await (await app.request("/", {}, env)).text()).toLowerCase();
    expect(html).toContain("#141117");
    expect(html).toContain("#ff9c36");
    for (const stale of ["#151720", "#f5f6fb", "#a3ff12", "#c6cbea", "#222430", "#41465c"]) {
      expect(html, `stale token ${stale}`).not.toContain(stale);
    }
  });

  it("every §2 text pair recomputes to its AA table ratio", () => {
    const t = themeTokens();
    const v = (name: string) => {
      const hex = t.get(name);
      expect(hex, `--theme-${name} defined`).toBeDefined();
      return hex as string;
    };
    const pairs: Array<[string, string, number]> = [
      [v("text"), v("page"), 17.47],
      [v("muted"), v("page"), 9.67],
      [v("text"), v("surface"), 15.94],
      [v("muted"), v("surface"), 8.83],
      [v("text"), v("raised"), 14.5],
      [v("muted"), v("raised"), 8.03],
      [v("accent-ink"), v("accent"), 9.15],
      ["#ffffff", v("violet"), 10.39],
      ["#ffffff", v("violet-deep"), 13.78],
      [v("link"), v("page"), 9.83],
      [v("success"), v("page"), 10.49],
      [v("warn"), v("page"), 10.23],
      [v("danger"), v("page"), 6.88],
      ["#20060f", v("pink"), 4.97],
    ];
    for (const [fg, bg, table] of pairs) {
      const ratio = contrast(fg, bg);
      expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio, `${fg} on ${bg} matches §2`).toBeCloseTo(table, 1);
    }
  });

  it("white on signal pink stays large-display-only (3.86:1, below the 4.5 floor)", () => {
    const pink = themeTokens().get("pink");
    expect(pink).toBe("#ff0e52");
    const ratio = contrast("#ffffff", pink as string);
    expect(ratio).toBeLessThan(4.5);
    expect(ratio).toBeCloseTo(3.86, 1);
  });
});

describe("primary CTA ink (BRAND-SYSTEM §2: dark-on-orange, never white)", () => {
  it("the .btn rule fills accent and inks dark via --brand-ink", () => {
    const css = read("public/theme.css");
    const base = css.match(/\.base-theme \.btn \{([^}]*)\}/);
    expect(base, ".base-theme .btn rule").toBeTruthy();
    expect(base![1]).toContain("background: var(--brand)");
    expect(base![1]).toContain("var(--brand-ink)");
    expect(base![1]).not.toContain("var(--paper)");
  });

  it("the .btn hover keeps dark ink on accent", () => {
    const css = read("public/theme.css");
    const hover = css.match(/\.base-theme \.btn:hover \{([^}]*)\}/);
    expect(hover, ".base-theme .btn:hover rule").toBeTruthy();
    expect(hover![1]).toContain("var(--brand-ink)");
    expect(hover![1]).not.toContain("var(--paper)");
  });

  it("signal pink never pairs with light text outside gradients", () => {
    for (const sheet of [
      "public/theme.css",
      "public/event-theme.css",
      "public/profile-theme.css",
      "public/schedule-theme.css",
      "web/src/app.css",
    ]) {
      const css = read(sheet);
      const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
      const noGradients = noComments.replace(/linear-gradient\([^;()]*\)/g, "");
      expect(noGradients, `${sheet}: pink outside gradients`).not.toMatch(/ff0e52/i);
    }
  });
});

describe("gradient rationing (BRAND-SYSTEM §5)", () => {
  it("theme-tokens.css ships the 3px gradient hairline utility", () => {
    const css = read("public/theme-tokens.css");
    expect(css).toContain(".brand-gradient-rule");
    const rule = css.match(/\.brand-gradient-rule\s*\{([^}]*)\}/);
    expect(rule, ".brand-gradient-rule block").toBeTruthy();
    expect(rule![1]).toMatch(/height:\s*3px/);
  });

  it("no gradient body text: background-clip:text stays out of component sheets", () => {
    for (const sheet of [
      "public/theme.css",
      "public/event-theme.css",
      "public/profile-theme.css",
      "public/schedule-theme.css",
      "web/src/app.css",
    ]) {
      expect(read(sheet), sheet).not.toContain("background-clip: text");
      expect(read(sheet), sheet).not.toContain("background-clip:text");
    }
  });

  it("brand-stop gradients live only in the token file, never in components", () => {
    for (const sheet of [
      "public/theme.css",
      "public/event-theme.css",
      "public/profile-theme.css",
      "public/schedule-theme.css",
      // web/src/app.css is the Kit @theme token mirror (BRAND-SYSTEM §6), not a component sheet.
    ]) {
      const css = read(sheet).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, `${sheet}: orange stop`).not.toMatch(/#ff9c36/i);
      expect(css, `${sheet}: pink stop`).not.toMatch(/#ff0e52/i);
      expect(css, `${sheet}: violet stop`).not.toMatch(/#5701ae/i);
    }
  });
});

describe("header lockup (BRAND-SYSTEM §4: inline Logo 1, accessible, sized)", () => {
  it("Hono header inlines the lockup SVG with the brand viewBox", async () => {
    const html = await (await app.request("/", {}, env)).text();
    const header = headerSlice(html);
    const svg = svgOpenTag(header);
    expect(svg, "header inlines an <svg>").toBeTruthy();
    const viewBox = svg!.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    expect(viewBox, "lockup viewBox").toBeTruthy();
    const ratio = Number(viewBox![1]) / Number(viewBox![2]);
    expect(ratio, "lockup aspect 456.86:126.34").toBeCloseTo(LOCKUP_RATIO, 2);
  });

  it("Hono header lockup carries the Logo 1 gradient and title", async () => {
    const html = await (await app.request("/", {}, env)).text();
    const header = headerSlice(html).toLowerCase();
    expect(header).toContain("twograd");
    for (const stop of ["#ff9c36", "#ff0e52", "#5701ae"]) {
      expect(header, `gradient stop ${stop}`).toContain(stop);
    }
    expect(header).toContain("<title");
  });

  it("Hono header lockup keeps an accessible name", async () => {
    const html = await (await app.request("/", {}, env)).text();
    const header = headerSlice(html);
    expect(header).toContain('aria-label="Together We Own homepage"');
    const svg = svgOpenTag(header);
    expect(svg, "header inlines an <svg>").toBeTruthy();
    expect(
      svg!.includes('role="img"') || svg!.includes("aria-hidden"),
      "svg names itself (role=img) or defers to the link label (aria-hidden)",
    ).toBe(true);
  });

  it("Hono header lockup meets the 96px minimum at the brand aspect", async () => {
    const html = await (await app.request("/", {}, env)).text();
    const header = headerSlice(html);
    const svg = svgOpenTag(header);
    expect(svg, "header inlines an <svg>").toBeTruthy();
    const width = svg!.match(/width="([\d.]+)"/);
    expect(width, "lockup width attribute").toBeTruthy();
    expect(Number(width![1]), "lockup >= 96px (§4 minimum)").toBeGreaterThanOrEqual(96);
    const height = svg!.match(/height="([\d.]+)"/);
    if (height) {
      expect(Number(width![1]) / Number(height[1]), "lockup aspect").toBeCloseTo(LOCKUP_RATIO, 1);
    }
  });

  it("Hono header no longer serves the old /logo.svg text mark", async () => {
    const html = await (await app.request("/", {}, env)).text();
    expect(headerSlice(html)).not.toContain("logo.svg");
  });

  it("Kit header inlines the lockup SVG with the brand gradient", async () => {
    const header = headerSlice(kit.renderHeader({}));
    const svg = svgOpenTag(header);
    expect(svg, "Kit header inlines an <svg>").toBeTruthy();
    const lower = header.toLowerCase();
    expect(lower).toContain("twograd");
    for (const stop of ["#ff9c36", "#ff0e52", "#5701ae"]) {
      expect(lower, `gradient stop ${stop}`).toContain(stop);
    }
    expect(lower).toContain("<title");
  });

  it("Kit header lockup keeps an accessible name and the 96px minimum", async () => {
    const header = headerSlice(kit.renderHeader({}));
    expect(header).toContain('aria-label="Together We Own homepage"');
    const svg = svgOpenTag(header);
    expect(svg, "Kit header inlines an <svg>").toBeTruthy();
    expect(
      svg!.includes('role="img"') || svg!.includes("aria-hidden"),
      "svg names itself (role=img) or defers to the link label (aria-hidden)",
    ).toBe(true);
    const width = svg!.match(/width="([\d.]+)"/);
    expect(width, "lockup width attribute").toBeTruthy();
    expect(Number(width![1]), "lockup >= 96px (§4 minimum)").toBeGreaterThanOrEqual(96);
  });

  it("Kit header no longer serves the old /logo.svg text mark", async () => {
    expect(headerSlice(kit.renderHeader({}))).not.toContain("logo.svg");
  });
});

describe("fonts (BRAND-SYSTEM §3: Chakra Petch + Inter, self-hosted woff2)", () => {
  const fontsDir = () => readdirSync(join(root, "public/fonts"));

  it("Chakra Petch 600/700 latin woff2 ships in public/fonts", () => {
    const names = fontsDir();
    expect(
      names.some((n) => /chakra.*600.*\.woff2/i.test(n)),
      "chakra 600 woff2",
    ).toBe(true);
    expect(
      names.some((n) => /chakra.*700.*\.woff2/i.test(n)),
      "chakra 700 woff2",
    ).toBe(true);
    for (const n of names.filter((x) => /chakra.*\.woff2/i.test(x))) {
      expect(readFileSync(join(root, "public/fonts", n)).length, n).toBeGreaterThan(1024);
    }
  });

  it("Inter body woff2 ships in public/fonts", () => {
    const names = fontsDir();
    const inter = names.filter((n) => /inter.*\.woff2/i.test(n));
    expect(inter.length, "inter woff2 present").toBeGreaterThanOrEqual(1);
    for (const n of inter) {
      expect(readFileSync(join(root, "public/fonts", n)).length, n).toBeGreaterThan(1024);
    }
  });

  it("@font-face serves both families with font-display: swap", () => {
    const css = ["public/theme.css", "public/theme-tokens.css", "public/styles.css"]
      .map((f) => read(f))
      .join("\n");
    for (const family of ["Chakra Petch", "Inter"]) {
      const blocks = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
      const faces = blocks.filter((b) => b.includes(family));
      expect(faces.length, `@font-face ${family}`).toBeGreaterThanOrEqual(1);
      for (const face of faces) {
        expect(face, `${family} swaps`).toMatch(/font-display:\s*swap/);
        expect(face, `${family} self-hosts woff2`).toContain(".woff2");
      }
    }
  });

  it("type tokens name Chakra Petch display over the Rajdhani fallback", () => {
    const css = read("public/theme-tokens.css");
    expect(css).toContain("--two-font-display:");
    expect(css).toContain("Chakra Petch");
    expect(css, "rajdhani Display face stays in the stack").toContain('"Display"');
    expect(css).toContain("--two-font-body:");
    expect(css).toContain("Inter");
  });

  it("Hono home preloads the Chakra Petch woff2", async () => {
    const html = await (await app.request("/", {}, env)).text();
    expect(html.toLowerCase()).toContain("chakra");
    const preloads = [...html.matchAll(/<link[^>]*rel="preload"[^>]*>/g)].map((m) => m[0]);
    const font = preloads.filter((l) => l.toLowerCase().includes("chakra"));
    expect(font.length, "chakra preload link").toBeGreaterThanOrEqual(1);
    expect(font[0]).toContain('as="font"');
    expect(font[0]).toContain("font/woff2");
    expect(font[0]).toContain('crossorigin="anonymous"');
  });

  it("Kit metadata preloads the Chakra Petch woff2 on themed pages", async () => {
    const html = kit.renderMeta({ title: "Fixture", theme: "home" });
    expect(html.toLowerCase()).toContain("chakra");
    expect(html).toContain('as="font"');
  });

  it("no remote font origin: woff2 stays self-hosted", () => {
    const css = ["public/theme.css", "public/theme-tokens.css", "public/styles.css"]
      .map((f) => read(f))
      .join("\n");
    const shells = read("src/page-shell.tsx") + read("web/src/lib/SiteMetadata.svelte");
    for (const origin of ["fonts.googleapis.com", "fonts.gstatic.com"]) {
      expect(css, `css references ${origin}`).not.toContain(origin);
      expect(shells, `shell references ${origin}`).not.toContain(origin);
    }
  });

  it("Rajdhani stays on disk as the display fallback", () => {
    expect(existsSync(join(root, "public/fonts/display-latin-700.woff2"))).toBe(true);
    expect(existsSync(join(root, "public/fonts/display-latin-500.woff2"))).toBe(true);
  });

  it("the new faces retain their OFL attribution under public/fonts", () => {
    const notes = fontsDir().filter((n) => /\.txt$/i.test(n));
    const bodies = notes.map((n) => read(`public/fonts/${n}`)).join("\n");
    expect(
      bodies.includes("Chakra Petch") || bodies.includes("Inter"),
      "an OFL note names Chakra Petch or Inter",
    ).toBe(true);
  });
});

describe("favicon, manifest and OG (BRAND-SYSTEM §6 wiring)", () => {
  it("public/favicon.svg is the Logo 1 mark on the brand-dark tile", () => {
    expect(existsSync(join(root, "public/favicon.svg")), "public/favicon.svg").toBe(true);
    const svg = read("public/favicon.svg").toLowerCase();
    expect(svg).toContain("<svg");
    expect(svg, "brand-dark tile").toContain("#141117");
  });

  it("the 32px PNG ships at a standard path", () => {
    const candidates = ["public/icons/icon-32.png", "public/icons/favicon-32.png"];
    const found = candidates.find((c) => existsSync(join(root, c)));
    expect(found, "32px icon (icons/icon-32.png or icons/favicon-32.png)").toBeTruthy();
    const size = pngSize(join(root, found as string));
    expect(size).toEqual({ width: 32, height: 32 });
  });

  it("apple-touch, 192, 512 and maskable PNGs keep their sizes", () => {
    expect(pngSize(join(root, "public/icons/apple-touch-icon.png"))).toEqual({
      width: 180,
      height: 180,
    });
    expect(pngSize(join(root, "public/icons/icon-192.png"))).toEqual({
      width: 192,
      height: 192,
    });
    expect(pngSize(join(root, "public/icons/icon-512.png"))).toEqual({
      width: 512,
      height: 512,
    });
    expect(pngSize(join(root, "public/icons/maskable-512.png"))).toEqual({
      width: 512,
      height: 512,
    });
  });

  it("public/og-1200x630.png is the 1200x630 social render", () => {
    expect(existsSync(join(root, "public/og-1200x630.png")), "public/og-1200x630.png").toBe(true);
    expect(pngSize(join(root, "public/og-1200x630.png"))).toEqual({
      width: 1200,
      height: 630,
    });
  });

  it("site.webmanifest recolors to brand-dark and keeps install identity", () => {
    const manifest = JSON.parse(read("public/site.webmanifest"));
    expect(manifest.theme_color.toLowerCase()).toBe("#141117");
    expect(manifest.background_color.toLowerCase()).toBe("#141117");
    expect(manifest).toMatchObject({
      id: "/",
      name: "Together We Own",
      short_name: "TWO",
      start_url: "/",
    });
    const srcs = (manifest.icons as Array<{ src: string }>).map((i) => i.src);
    for (const kept of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"]) {
      expect(srcs, `manifest keeps ${kept}`).toContain(kept);
    }
  });

  it("Hono home head: brand theme-color, svg favicon, manifest, icons", async () => {
    const html = await (await app.request("/", {}, env)).text();
    expect(html).toContain('<meta name="theme-color" content="#141117"');
    expect(html).toContain('rel="icon"');
    expect(html).toContain("favicon.svg");
    expect(html).toContain('type="image/svg+xml"');
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain("/icons/icon-192.png");
  });

  it("Hono home head: absolute OG/Twitter image with the large card", async () => {
    const html = await (await app.request("/", {}, env)).text();
    const image = `${APP_URL}/og-1200x630.png`;
    expect(html).toContain(`<meta property="og:image" content="${image}"`);
    expect(html).toContain(`<meta name="twitter:image" content="${image}"`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
  });

  it("events shells pass canonical, so the shared Layout tags them too", () => {
    expect(read("src/events/pages-calendar-screen.tsx")).toContain(
      'canonicalUrl(appUrl, "/events")',
    );
    expect(read("src/events/pages-detail.tsx")).toContain("canonical=");
  });

  it("Kit app.html: brand theme-color, svg favicon, manifest, icons", () => {
    const html = read("web/src/app.html").toLowerCase();
    expect(html).toContain('<meta name="theme-color" content="#141117"');
    expect(html).toContain("favicon.svg");
    expect(html).toContain('type="image/svg+xml"');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain("/icons/icon-192.png");
  });

  it("Kit SiteMetadata wires the OG/Twitter image on canonical pages", () => {
    const source = read("web/src/lib/SiteMetadata.svelte");
    expect(source).toContain("og:image");
    expect(source).toContain("twitter:image");
    expect(source).toContain("summary_large_image");
    // The literal asset is owned by the shared SEO helper, not this component.
    expect(read("src/seo.ts")).toContain('SHARE_IMAGE_PATH = "/og-1200x630.png"');
    for (const canonical of [
      "https://next.example.test/about",
      "https://share.example.test/e/fixture",
    ]) {
      const html = kit.renderMeta({ title: "Fixture", theme: "home", canonical });
      const image = `${new URL(canonical).origin}/og-1200x630.png`;
      const values = (attribute: string, key: string) =>
        [...html.matchAll(/<meta\s+[^>]*>/g)]
          .map(([tag]) => tag)
          .filter((tag) => tag.includes(`${attribute}="${key}"`))
          .map((tag) => tag.match(/content="([^"]*)"/)?.[1]);
      expect(values("property", "og:image")).toEqual([image]);
      expect(values("property", "og:image:alt")).toEqual(["Together We Own community logo"]);
      expect(values("name", "twitter:image")).toEqual([image]);
      expect(values("name", "twitter:card")).toEqual(["summary_large_image"]);
    }
  });

  it("Kit SiteMetadata keeps pages without canonical free of share images", async () => {
    const html = kit.renderMeta({ title: "Fixture", theme: "home" });
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("twitter:image");
  });

  it("branded 404 carries the brand head", async () => {
    const html = await (await scratchErrors().request("/nope")).text();
    expect(html).toContain("We cannot find that page");
    expect(html).toContain('<meta name="theme-color" content="#141117"');
    expect(html).toContain("favicon.svg");
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest"');
  });

  it("branded 503 carries the brand head", async () => {
    const res = await scratchErrors().request("/down");
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain('<meta name="theme-color" content="#141117"');
    expect(html).toContain("favicon.svg");
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest"');
  });
});

describe("consolidation: the single-file swap (BRAND-SYSTEM §6)", () => {
  it("src/headers.ts error-fallback CSS recolors to the brand", () => {
    const css = read("src/headers.ts").toLowerCase();
    expect(css).toContain("#141117");
    expect(css).toContain("#f7f7f7");
    expect(css).toContain("#ff9c36");
    expect(css).not.toContain("#c2f45b");
    expect(css).not.toContain("#121719");
  });

  it("web/src/error.html catastrophic fallback recolors to the brand", () => {
    const css = read("web/src/error.html").toLowerCase();
    expect(css).toContain("#141117");
    expect(css).toContain("#f7f7f7");
    expect(css).toContain("#ff9c36");
    expect(css).not.toContain("#c2f45b");
    expect(css).not.toContain("#121719");
  });

  it("ci/generate-icons.py no longer claims the temporary wordmark", () => {
    if (!existsSync(join(root, "ci/generate-icons.py"))) return;
    expect(read("ci/generate-icons.py")).not.toContain("temporary TWO wordmark");
  });

  it("docs/home-theme.md documents the new display face", () => {
    expect(read("docs/home-theme.md").toLowerCase()).toContain("chakra petch");
  });
});
