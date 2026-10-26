// Independent acceptance for printing the two reference leaves, /rules and
// /faq: a member who prints (or saves to PDF) must get the complete house
// rules and every FAQ answer — including sections never scrolled into view —
// in a single readable column on paper colors, without navigation or action
// clutter, while the screen pages stay exactly as they are.
//
// The production change these tests demand is a print stylesheet for the
// existing Rules and FAQ leaves, delivered through the established leaf CSS
// path: the real stylesheet sources in public/ plus the regenerated
// src/leaf-critical-css.ts, so Hono and the compiled Kit pages print the
// same way. At the pin this suite was written against there is no @media
// print anywhere, so the print-contract tests fail for that reason alone;
// the content/screen controls pass and must keep passing.
//
// Print rules must be scoped to the rules/FAQ leaves: theme.css also loads
// on event shells and the leaf bundle also styles /about and /privacy, so
// an unscoped print rule silently restyles pages this contract does not own.
// Scoping is judged from the served markup: a selector counts as scoped
// when it mentions an id, class or data attribute that only the rules/FAQ
// pages carry (today `data-testid="rules-list"`, `data-testid="faq-list"`,
// the `#rule-*` / `#faq-*` anchors, .jump, .rule-permalink, ...).
//
// Browser level is opt-in where Chromium is installed, mirroring
// test/profile-composition-browser.test.ts:
//   A11Y_BROWSER_TESTS=true npx vitest run test/reference-print-acceptance.test.ts
// It drives the real served HTML of both renderers through print-media
// emulation without scrolling, and generates a PDF. No live database, PDF
// service or network fixture is used anywhere in this file.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { FAQS, faqPageData } from "../src/faq-content";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
import { RULES, RULES_INTRO, rulesPageData } from "../src/rules-content";
import app from "./app";

const APP_URL = "https://next.example.test";
const STAMP_ISO = "2026-09-01";
const STAMP_HTML = `<time datetime="${STAMP_ISO}">1 September 2026</time>`;

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  RULES_LAST_UPDATED: STAMP_ISO,
  FAQ_LAST_REVIEWED: STAMP_ISO,
};

// The external destinations a printed page must keep reachable in words.
const EXTERNAL_LINKS = FAQS.flatMap((group) =>
  group.items.flatMap(([, , link]) => (link ? [link] : [])),
);

// ---------------------------------------------------------------------------
// CSS reading helpers. The leaf bundle is small, flat CSS; brace matching is
// enough to separate the print block from the screen rules honestly.
// ---------------------------------------------------------------------------

type CssPart = { selector: string; declarations: string };

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Split into the concatenated @media print bodies and everything else. */
function splitPrint(css: string): { print: string[]; rest: string } {
  const print: string[] = [];
  let rest = "";
  let last = 0;
  const re = /@media([^{]*)\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const open = re.lastIndex - 1;
    let depth = 1;
    let end = open + 1;
    while (end < css.length && depth > 0) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}") depth--;
      end++;
    }
    rest += css.slice(last, match.index);
    if (/\bprint\b/.test(match[1] ?? "")) print.push(css.slice(open + 1, end - 1));
    else rest += css.slice(match.index, end);
    last = end;
    re.lastIndex = end;
  }
  rest += css.slice(last);
  return { print, rest };
}

/** Flatten a CSS fragment into one entry per comma-separated selector. */
function parseParts(fragment: string): CssPart[] {
  const parts: CssPart[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(fragment)) !== null) {
    const declarations = match[2] ?? "";
    for (const raw of (match[1] ?? "").split(",")) {
      const selector = raw.trim().replace(/\s+/g, " ").replace(/'/g, '"');
      if (selector) parts.push({ selector, declarations });
    }
  }
  return parts;
}

function luminance(token: string): number | null {
  const t = token.trim().toLowerCase();
  if (t === "white") return 1;
  if (t === "black") return 0;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (hex) {
    const digits = hex[1] ?? "";
    const full = digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
    const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    return (channels[0]! + channels[1]! + channels[2]!) / 3 / 255;
  }
  const rgb = /^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(t);
  if (rgb) return (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3 / 255;
  return null;
}

/** Custom properties a part list (re)defines, lower-cased name -> raw value. */
function varDefsOf(parts: CssPart[]): Map<string, string> {
  const defs = new Map<string, string>();
  for (const part of parts) {
    for (const m of part.declarations.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
      defs.set((m[1] ?? "").toLowerCase(), (m[2] ?? "").trim());
    }
  }
  return defs;
}

/** Luminance of the first paint in a declaration value, resolving var() once. */
function paintLuminance(value: string, defs: Map<string, string>): number | null {
  const viaVar = /var\(\s*(--[a-z0-9-]+)\s*(?:,([^)]*))?\)/i.exec(value);
  if (viaVar) {
    const defined = defs.get((viaVar[1] ?? "").toLowerCase());
    if (defined !== undefined) return luminance(defined);
    return viaVar[2] ? luminance(viaVar[2]) : null;
  }
  const direct = /(#[0-9a-f]{3,6}\b|rgba?\([^)]*\)|\bwhite\b|\bblack\b)/i.exec(value);
  return direct ? luminance(direct[1] ?? "") : null;
}

/** Luminances of every `property: ...` declaration in a part. */
function declLuminances(part: CssPart, property: string, defs: Map<string, string>): number[] {
  const out: number[] = [];
  const re = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "gi");
  for (const m of part.declarations.matchAll(re)) {
    const lum = paintLuminance(m[1] ?? "", defs);
    if (lum !== null) out.push(lum);
  }
  return out;
}

const hasDecl = (part: CssPart, re: RegExp) => re.test(part.declarations);

// ---------------------------------------------------------------------------
// Fixtures: real Hono responses and real compiled Kit pages.
// ---------------------------------------------------------------------------

type KitRender = (data: unknown) => string;

// Same SSR harness as the Kit parity suites: the web workspace's own
// svelte/compiler, esbuild bundle, leafCss merged like the server loads do.
async function buildKitPage(pageFile: string): Promise<KitRender> {
  const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: string; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };
  const worktree = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "reference-print-"));
  try {
    const entry = join(scratch, "entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, pageFile))};
import { LEAF_CRITICAL_CSS } from ${JSON.stringify(join(worktree, "src/leaf-critical-css.ts"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data: { ...data, leafCss: LEAF_CRITICAL_CSS } } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
    );
    const outfile = join(scratch, "page.mjs");
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: worktree,
      nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
      alias: { "#lib": fileURLToPath(new URL("../web/src/lib/", import.meta.url)) },
      plugins: [
        {
          name: "reference-print-svelte-ssr",
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
    const { renderPage } = (await import(pathToFileURL(outfile).href)) as {
      renderPage: KitRender;
    };
    return renderPage;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** Ids, classes and data attributes (minus the shared shell marker) used by a page. */
function scopeTokensOf(html: string): Set<string> {
  const markup = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const tokens = new Set<string>();
  for (const m of markup.matchAll(/\b(?:data-testid|id)="([^"]+)"/g)) tokens.add(m[1] ?? "");
  for (const m of markup.matchAll(/\bclass="([^"]+)"/g)) {
    for (const token of (m[1] ?? "").split(/\s+/)) if (token) tokens.add(token);
  }
  for (const m of markup.matchAll(/\b(data-[a-z0-9-]+)="([^"]*)"/g)) {
    if (m[1] === "data-theme" || m[1] === "data-testid") continue;
    tokens.add(m[1] ?? "");
    if (m[2]) tokens.add(m[2]);
  }
  return tokens;
}

let honoRules = "";
let honoFaq = "";
let kitRules = "";
let kitFaq = "";
let renderKitRules: KitRender;
let renderKitFaq: KitRender;
let printParts: CssPart[] = [];
let screenCss = "";
let isScoped: (selector: string) => boolean = () => false;

beforeAll(async () => {
  const get = async (path: string) => {
    const res = await app.request(path, {}, env);
    expect(res.status, `${path} fixture`).toBe(200);
    return res.text();
  };
  honoRules = await get("/rules");
  honoFaq = await get("/faq");
  const honoAbout = await get("/about");
  const honoPrivacy = await get("/privacy");

  renderKitRules = await buildKitPage("web/src/routes/rules/+page.svelte");
  renderKitFaq = await buildKitPage("web/src/routes/faq/+page.svelte");
  kitRules = renderKitRules(rulesPageData(APP_URL, STAMP_ISO));
  kitFaq = renderKitFaq(faqPageData(APP_URL, STAMP_ISO));

  const { print, rest } = splitPrint(stripComments(LEAF_CRITICAL_CSS));
  printParts = print.flatMap((block) => parseParts(block));
  screenCss = rest;

  const reference = new Set<string>();
  for (const html of [honoRules, honoFaq, kitRules, kitFaq]) {
    for (const token of scopeTokensOf(html)) reference.add(token);
  }
  for (const html of [honoAbout, honoPrivacy]) {
    for (const token of scopeTokensOf(html)) reference.delete(token);
  }
  const distinctive = [...reference].filter((token) => token.length >= 4);
  isScoped = (selector) => distinctive.some((token) => selector.includes(token));
}, 120_000);

const scopedParts = () => printParts.filter((part) => isScoped(part.selector));

// ---------------------------------------------------------------------------
// Delivery: the print rules ride the established leaf CSS path to both
// renderers, from the real sources — not hand-edited generated CSS, not a
// second print-only stylesheet one renderer could forget.
// ---------------------------------------------------------------------------

describe("reference print delivery", () => {
  it("bundles a print stylesheet in the leaf CSS", () => {
    expect(printParts.length).toBeGreaterThan(0);
  });

  it("takes the print rules from the public stylesheet sources, not only the generated module", () => {
    const sources = ["styles.css", "theme-tokens.css", "theme.css"]
      .map((name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"))
      .join("\n");
    const { print } = splitPrint(stripComments(sources));
    expect(print.flatMap((block) => parseParts(block)).length).toBeGreaterThan(0);
    // And the generated bundle is exactly those sources (drift contract).
    expect(LEAF_CRITICAL_CSS).toBe(sources);
  });

  it("serves the print rules inline on the Hono rules and FAQ leaves", () => {
    for (const html of [honoRules, honoFaq]) {
      expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
      expect(splitPrint(stripComments(style)).print.length).toBeGreaterThan(0);
    }
  });

  it("renders the same print rules on the compiled Kit rules and FAQ pages", () => {
    for (const html of [kitRules, kitFaq]) {
      expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
      expect(splitPrint(stripComments(style)).print.length).toBeGreaterThan(0);
    }
  });

  it("keeps the Kit server loads feeding the leaf CSS to both pages", () => {
    for (const route of ["rules", "faq"]) {
      const source = readFileSync(
        new URL(`../web/src/routes/${route}/+page.server.ts`, import.meta.url),
        "utf8",
      );
      expect(source).toContain("leafCss: LEAF_CRITICAL_CSS");
    }
  });
});

// ---------------------------------------------------------------------------
// Paper presentation: readable ink on paper, one column, no clutter.
// ---------------------------------------------------------------------------

describe("reference print presentation", () => {
  it("scopes every print selector to the rules/FAQ leaves so events and unrelated leaves keep their own print", () => {
    expect(printParts.length).toBeGreaterThan(0);
    const offenders = printParts
      .filter((part) => !part.selector.startsWith("@page") && !isScoped(part.selector))
      .map((part) => part.selector);
    expect(offenders).toEqual([]);
  });

  it("prints on paper colours: a light page with dark body and muted text", () => {
    const parts = scopedParts();
    const defs = varDefsOf(printParts);
    const scopedDefs = varDefsOf(parts);
    const varLum = (name: string) => {
      const value = scopedDefs.get(name);
      return value === undefined ? null : luminance(value);
    };
    const paintsWith = (property: string, pick: (lum: number) => boolean, where: RegExp) =>
      parts.some(
        (part) =>
          where.test(part.selector) &&
          declLuminances(part, property, defs).some((lum) => pick(lum)),
      );

    const lightPage =
      paintsWith(
        "background(?:-color)?",
        (lum) => lum > 0.8,
        /base-theme|content|body|main|html/,
      ) || [varLum("--color-page"), varLum("--paper")].some((lum) => lum !== null && lum > 0.8);
    expect(lightPage, "a light paper background").toBe(true);

    const darkText =
      paintsWith("color", (lum) => lum < 0.4, /base-theme|content-page|body|main/) ||
      [varLum("--color-text"), varLum("--ink")].some((lum) => lum !== null && lum < 0.4);
    expect(darkText, "dark primary text").toBe(true);

    // Paragraphs and answers paint with the muted token on screen; leaving
    // it the light screen lavender would make the answers unreadable ink.
    const darkMuted =
      paintsWith("color", (lum) => lum < 0.4, /(^|[\s>+~])p\b|card|content-page|dd\b/) ||
      [varLum("--color-muted"), varLum("--muted")].some((lum) => lum !== null && lum < 0.4);
    expect(darkMuted, "dark muted/answer text").toBe(true);
  });

  it("keeps rule markers and links readable on paper instead of the screen accent", () => {
    const parts = scopedParts();
    const defs = varDefsOf(printParts);
    const scopedDefs = varDefsOf(parts);
    const brand = scopedDefs.get("--brand") ?? scopedDefs.get("--color-accent");
    const brandLum = brand === undefined ? null : luminance(brand);
    const brandReadable = brandLum !== null && brandLum < 0.6;
    const markerReadable = parts.some(
      (part) =>
        part.selector.includes("::marker") &&
        declLuminances(part, "color", defs).some((lum) => lum < 0.6),
    );
    const linkReadable = parts.some(
      (part) =>
        /(^|[\s>+~])a(\b|:|\[|\.)/.test(part.selector) &&
        declLuminances(part, "color", defs).some((lum) => lum < 0.6),
    );
    expect(brandReadable || markerReadable, "readable rule markers").toBe(true);
    expect(brandReadable || linkReadable, "readable links").toBe(true);
  });

  it("collapses the two-column reference layouts to a single print column", () => {
    const parts = scopedParts();
    const singleColumn = (part: CssPart) =>
      hasDecl(part, /display\s*:\s*block/) ||
      hasDecl(
        part,
        /grid-template-columns\s*:\s*(1fr|none|minmax\(\s*0\s*,\s*1fr\s*\)|100%)\s*(;|!|$)/,
      );
    expect(
      parts.some((part) => part.selector.includes("content-layout") && singleColumn(part)),
      "content layout becomes one column",
    ).toBe(true);
    expect(
      parts.some(
        (part) =>
          part.selector.includes("faq-list") &&
          part.selector.includes("section") &&
          singleColumn(part),
      ),
      "FAQ section grid becomes one column",
    ).toBe(true);
  });

  it("removes site chrome and community navigation from paper", () => {
    const parts = scopedParts();
    const hidden = (where: (selector: string) => boolean) =>
      parts.some((part) => where(part.selector) && hasDecl(part, /display\s*:\s*none/));
    expect(
      hidden((s) => s.includes("site-header") || /(^|[\s>+~])header(\b|\.|#|:)/.test(s)),
      "site header hidden",
    ).toBe(true);
    expect(
      hidden((s) => s.includes("content-nav")),
      "community nav hidden",
    ).toBe(true);
    expect(
      hidden((s) => s.includes("footer")),
      "footer hidden",
    ).toBe(true);
  });

  it("removes join actions and in-page jump/permalink clutter from paper", () => {
    const parts = scopedParts();
    const hidden = (where: (selector: string) => boolean) =>
      parts.some((part) => where(part.selector) && hasDecl(part, /display\s*:\s*none/));
    expect(
      hidden(
        (s) =>
          s.includes("rules-join") ||
          s.includes("faq-join") ||
          /(^|[\s>+~.,])(btn)\b/.test(s) ||
          s.includes(".btn"),
      ),
      "join buttons hidden",
    ).toBe(true);
    expect(
      hidden((s) => s.includes("rules-jump") || s.includes("jump") || s.includes("rule-permalink")),
      "jump index / permalinks hidden",
    ).toBe(true);
  });

  it("reveals every FAQ section for print before any scroll", () => {
    const parts = scopedParts();
    expect(
      parts.some(
        (part) =>
          part.selector.includes("faq-list") &&
          hasDecl(part, /content-visibility\s*:\s*(visible|unset|initial)/),
      ),
      "content-visibility overridden for print",
    ).toBe(true);
    expect(
      parts.some((part) => hasDecl(part, /content-visibility\s*:\s*(auto|hidden)/)),
      "print never re-hides sections behind content-visibility",
    ).toBe(false);
  });

  it("keeps rules and questions intact across pages without forcing a page per item", () => {
    const parts = scopedParts();
    expect(
      parts.some(
        (part) =>
          /(card|\bli\b|rules-list|faq-list)/.test(part.selector) &&
          hasDecl(part, /(break-inside|page-break-inside)\s*:\s*avoid/),
      ),
      "rule/question blocks avoid splitting",
    ).toBe(true);
    expect(
      parts.some(
        (part) =>
          /\bh[23]\b/.test(part.selector) &&
          hasDecl(part, /(break-after|page-break-after)\s*:\s*avoid/),
      ),
      "headings stay with the text they introduce",
    ).toBe(true);
    // Blank-gap and clipping guards: no forced page per item, and the big
    // containers are not glued into a single unbreakable block that a long
    // answer could overflow.
    expect(
      printParts.some((part) =>
        hasDecl(part, /(break-before|page-break-before)\s*:\s*(page|always)/),
      ),
      "no forced page-before per item",
    ).toBe(false);
    // Judge these by the selector's target (last compound), not its scope
    // qualifier: `.base-theme:has([data-testid="rules-list"]) .site-header`
    // hides chrome, not content.
    const targetOf = (selector: string) =>
      selector
        .replace(/:has\([^)]*\)/g, "")
        .split(/[\s>+~]+/)
        .filter(Boolean)
        .at(-1) ?? "";
    expect(
      parts.some(
        (part) =>
          /(faq-list|content-page)/.test(targetOf(part.selector)) &&
          hasDecl(part, /(break-inside|page-break-inside)\s*:\s*avoid/),
      ),
      "whole list/page is not one unbreakable block",
    ).toBe(false);
    expect(
      parts.some(
        (part) =>
          hasDecl(part, /display\s*:\s*none/) &&
          /(rules-list|faq-list|card)/.test(targetOf(part.selector)) &&
          !/(btn|join|jump|permalink|nav)/.test(targetOf(part.selector)),
      ),
      "print never hides the content blocks themselves",
    ).toBe(false);
  });

  it("prints a meaningful URL for external support links without expanding fragments or internal paths", () => {
    expect(EXTERNAL_LINKS.length).toBeGreaterThan(0);
    const expansions = printParts.filter(
      (part) => part.selector.includes("::after") && part.declarations.includes("attr(href"),
    );
    const qualified = (selector: string) =>
      /\[href\^="(https?:)?\/\//.test(selector) ||
      /\[href\^="https?:/.test(selector) ||
      (selector.includes(':not([href^="#"]') && selector.includes(':not([href^="/"]'));
    const cssExpansion = expansions.some(
      (part) => isScoped(part.selector) && qualified(part.selector),
    );
    const visibleUrl = EXTERNAL_LINKS.every(
      (link) => visibleText(honoFaq).includes(link.href) && visibleText(kitFaq).includes(link.href),
    );
    expect(cssExpansion || visibleUrl, "external link destinations reach paper").toBe(true);
    // Any attr(href) expansion that exists must stay qualified: a bare
    // a::after would also print #rule fragments and internal paths.
    for (const part of expansions) expect(qualified(part.selector), part.selector).toBe(true);
  });

  it("keeps long printed URLs wrappable instead of clipped", () => {
    const parts = scopedParts();
    const printWrap = parts.some(
      (part) =>
        /(a\b|card|content|faq|rules|p\b)/.test(part.selector) &&
        hasDecl(
          part,
          /(overflow-wrap\s*:\s*(anywhere|break-word)|word-break\s*:\s*(break-all|break-word))/,
        ),
    );
    // The screen card rule already wraps anywhere and applies to print too;
    // it only counts once print actually surfaces the URL text.
    const cardWrap = /\.card[^{}]*\{[^}]*overflow-wrap\s*:\s*anywhere/.test(screenCss);
    const surfacesUrl =
      printParts.some((part) => part.declarations.includes("attr(href")) ||
      EXTERNAL_LINKS.every((link) => visibleText(honoFaq).includes(link.href));
    expect(printWrap || (cardWrap && surfacesUrl)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Completeness: what print can show is the (script-free) served DOM, so both
// renderers must carry every word, stamp and anchor — normal and long data.
// ---------------------------------------------------------------------------

function expectRulesComplete(html: string) {
  const text = visibleText(html);
  expect(text).toContain(RULES_INTRO);
  expect(html).toContain('data-testid="rules-last-updated"');
  expect(html).toContain(STAMP_HTML);
  expect(html).toContain('<ol data-testid="rules-list"');
  expect(html.match(/<li class="card">/g)).toHaveLength(RULES.length);
  for (const [name, body, id] of RULES) {
    expect(text).toContain(name);
    expect(text).toContain(body);
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`href="#${id}"`);
  }
  expect(html).not.toContain("<script");
}

function expectFaqComplete(html: string) {
  const text = visibleText(html);
  expect(html).toContain('data-testid="faq-last-reviewed"');
  expect(html).toContain(STAMP_HTML);
  for (const group of FAQS) {
    expect(html).toContain(`id="${group.sectionId}"`);
    expect(text).toContain(group.section);
    for (const [question, answer, link] of group.items) {
      expect(text).toContain(question);
      expect(text).toContain(answer.replace(/\s+/g, " "));
      if (link) {
        expect(html).toContain(`href="${link.href}"`);
        expect(text).toContain(link.label);
      }
    }
  }
  expect(html).not.toContain("<script");
}

describe("reference print completeness", () => {
  it("carries every rule, anchor and the stamp in the Hono DOM", () => {
    expectRulesComplete(honoRules);
  });

  it("carries every rule, anchor and the stamp in the Kit DOM", () => {
    expectRulesComplete(kitRules);
  });

  it("carries every FAQ section, question, answer, link and the stamp in the Hono DOM", () => {
    expectFaqComplete(honoFaq);
  });

  it("carries every FAQ section, question, answer, link and the stamp in the Kit DOM", () => {
    expectFaqComplete(kitFaq);
  });

  it("renders an arbitrarily long answer and URL in full (long fixture, Kit data path)", () => {
    const longAnswer = `${"A long answer keeps going. ".repeat(400)}ENDMARKER`;
    const longUrl = `https://example.test/${"very-long-segment/".repeat(12)}recovery`;
    const html = renderKitFaq({
      ...faqPageData(APP_URL, STAMP_ISO),
      faqs: [
        {
          section: "Long fixture",
          sectionId: "faq-long-fixture",
          items: [["Long question?", longAnswer, { label: "Long guide", href: longUrl }]],
        },
      ],
    });
    expect(visibleText(html)).toContain("ENDMARKER");
    expect(html).toContain(`href="${longUrl}"`);
  });

  it("renders an arbitrarily long rule body in full (long fixture, Kit data path)", () => {
    const longBody = `${"A long rule keeps going. ".repeat(400)}RULEEND`;
    const html = renderKitRules({
      ...rulesPageData(APP_URL, STAMP_ISO),
      rules: [["Long rule", longBody, "rule-long-fixture"]],
    });
    expect(visibleText(html)).toContain("RULEEND");
    expect(html).toContain('id="rule-long-fixture"');
  });
});

// ---------------------------------------------------------------------------
// Screen preservation controls: print work must not move the screen pages,
// restyle their chrome away, or drop the LCP content-visibility behaviour.
// ---------------------------------------------------------------------------

describe("reference print screen controls", () => {
  it("keeps the two-column screen layouts outside the print block", () => {
    expect(screenCss).toMatch(
      /\.content-layout\s*\{[^}]*grid-template-columns:\s*11rem minmax\(0,\s*1fr\)/,
    );
    expect(screenCss).toMatch(
      /faq-list[^{}]*section\s*\{[^}]*grid-template-columns:\s*11rem minmax\(0,\s*1fr\)/,
    );
    expect(screenCss).toMatch(/\.content-layout\s*\{\s*grid-template-columns:\s*1fr/);
  });

  it("keeps the screen FAQ render-skipping rule outside the print block", () => {
    expect(screenCss).toMatch(/\[data-testid=["']faq-list["']\]>section/);
    expect(screenCss).toContain("content-visibility:auto");
    expect(screenCss).toContain("contain-intrinsic-size:auto 20rem");
  });

  it("keeps numbered rule markers styled on screen", () => {
    expect(screenCss).toMatch(/rules-list[^{}]*li::marker\s*\{/);
    expect(screenCss).toMatch(/rules-list[^{}]*\{[^}]*list-style:\s*decimal/);
  });

  it("keeps chrome and actions in the served DOM of both renderers (print hides, markup stays)", () => {
    for (const html of [honoRules, honoFaq, kitRules, kitFaq]) {
      expect(html).toContain("site-header");
      expect(html).toContain('class="content-nav"');
      expect(html).toContain('aria-label="Community information"');
      expect(html).toContain("<footer");
    }
    for (const html of [honoRules, kitRules]) {
      expect(html).toContain('data-testid="rules-join"');
      expect(html).toContain('data-testid="rules-jump"');
    }
    for (const html of [honoFaq, kitFaq]) expect(html).toContain('data-testid="faq-join"');
  });

  it("never hides chrome on screen", () => {
    expect(screenCss).not.toMatch(
      /(site-header|content-nav|footer)[^{}]*\{[^}]*display\s*:\s*none/,
    );
  });
});

// ---------------------------------------------------------------------------
// Real-browser print: computed styles under print emulation are the ground
// truth the textual contract approximates (specificity, inheritance, the
// unscrolled content-visibility sections), plus an actual PDF render.
// ---------------------------------------------------------------------------

// The root tsconfig has no DOM lib; declare only what the probes touch
// (same pattern as test/event-chosen-timezone.test.ts).
interface ProbeElement {
  textContent: string | null;
  querySelector(selector: string): ProbeElement | null;
  closest(selector: string): ProbeElement | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
}
declare const window: { scrollY: number };
declare const document: {
  querySelector(selector: string): ProbeElement | null;
  querySelectorAll(selector: string): Iterable<ProbeElement>;
};
declare const getComputedStyle: (
  element: ProbeElement,
  pseudo?: string,
) => {
  display: string;
  gridTemplateColumns: string;
  backgroundColor: string;
  color: string;
  contentVisibility: string;
  content: string;
};

type PrintProbe = {
  scrollY: number;
  headerDisplay: string;
  footerDisplay: string;
  contentNavDisplay: string;
  joinDisplay: string | null;
  layoutDisplay: string;
  layoutColumns: number;
  themeBackground: string;
  answerColor: string;
  markerColor: string | null;
  faqSections: Array<{ contentVisibility: string; height: number }> | null;
  faqFirstCardStacks: boolean | null;
  externalAfterContent: string | null;
  externalVisibleText: string | null;
};

function rgbLuminance(rgb: string): number {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb);
  if (!m) return Number.NaN;
  if (m[4] !== undefined && Number(m[4]) === 0) return 1; // transparent over white paper
  return (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 / 255;
}

describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")(
  "reference print in a real browser (opt-in)",
  () => {
    let browser: Browser;
    let server: Server;
    let base = "";

    const pages: Array<{ name: string; path: string; kind: "rules" | "faq" }> = [
      { name: "Hono rules", path: "/rules", kind: "rules" },
      { name: "Hono FAQ", path: "/faq", kind: "faq" },
      { name: "Kit rules", path: "/kit/rules", kind: "rules" },
      { name: "Kit FAQ", path: "/kit/faq", kind: "faq" },
    ];

    beforeAll(async () => {
      const docs = new Map<string, string>([
        ["/rules", honoRules],
        ["/faq", honoFaq],
        ["/kit/rules", `<!doctype html><html lang="en">${kitRules}</html>`],
        ["/kit/faq", `<!doctype html><html lang="en">${kitFaq}</html>`],
      ]);
      server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const doc = docs.get(url.pathname);
        if (doc) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(doc);
          return;
        }
        try {
          const asset = readFileSync(new URL(`../public${url.pathname}`, import.meta.url));
          res.writeHead(200);
          res.end(asset);
        } catch {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      base = `http://127.0.0.1:${address.port}`;
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });

    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((resolve, reject) => {
        server?.closeAllConnections();
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    });

    async function probe(path: string, media: "screen" | "print"): Promise<PrintProbe> {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      try {
        const page = await context.newPage();
        await page.goto(`${base}${path}`, { waitUntil: "load" });
        await page.emulateMedia({ media });
        return (await page.evaluate(() => {
          const displayOf = (selector: string) => {
            const el = document.querySelector(selector);
            return el ? getComputedStyle(el).display : "missing";
          };
          const layout = document.querySelector(".content-layout");
          const layoutStyle = layout ? getComputedStyle(layout) : null;
          const theme = document.querySelector(".base-theme");
          const answer = document.querySelector(".content-page .card p");
          const firstRule = document.querySelector("[data-testid='rules-list'] li");
          const faqSectionEls = [
            ...document.querySelectorAll("[data-testid='faq-list'] > section"),
          ];
          const firstSection = faqSectionEls[0];
          const firstCard = firstSection?.querySelector(".card");
          const firstHeading = firstSection?.querySelector("h2");
          const external = document.querySelector(".content-page a[href^='https://']");
          return {
            scrollY: window.scrollY,
            headerDisplay: displayOf(".site-header"),
            footerDisplay: displayOf("footer"),
            contentNavDisplay: displayOf(".content-nav"),
            joinDisplay:
              displayOf("[data-testid='rules-join']") !== "missing"
                ? displayOf("[data-testid='rules-join']")
                : displayOf("[data-testid='faq-join']") !== "missing"
                  ? displayOf("[data-testid='faq-join']")
                  : null,
            layoutDisplay: layoutStyle?.display ?? "missing",
            layoutColumns: layoutStyle ? layoutStyle.gridTemplateColumns.split(" ").length : 0,
            themeBackground: theme ? getComputedStyle(theme).backgroundColor : "",
            answerColor: answer ? getComputedStyle(answer).color : "",
            markerColor: firstRule ? getComputedStyle(firstRule, "::marker").color : null,
            faqSections: faqSectionEls.length
              ? faqSectionEls.map((section) => ({
                  contentVisibility: getComputedStyle(section).contentVisibility,
                  height: section.getBoundingClientRect().height,
                }))
              : null,
            faqFirstCardStacks:
              firstCard && firstHeading
                ? firstCard.getBoundingClientRect().top >=
                  firstHeading.getBoundingClientRect().bottom - 1
                : null,
            externalAfterContent: external ? getComputedStyle(external, "::after").content : null,
            externalVisibleText: external?.closest("p")?.textContent ?? null,
          };
        })) as PrintProbe;
      } finally {
        await context.close();
      }
    }

    it.each(pages)("$name keeps its screen chrome and layout at desktop width", async (entry) => {
      const screen = await probe(entry.path, "screen");
      expect(screen.headerDisplay).not.toBe("none");
      expect(screen.footerDisplay).not.toBe("none");
      expect(screen.contentNavDisplay).not.toBe("none");
      expect(screen.layoutColumns).toBeGreaterThan(1);
      if (entry.kind === "faq") {
        for (const section of screen.faqSections ?? []) {
          expect(section.contentVisibility).toBe("auto");
        }
      }
    });

    it.each(pages)(
      "$name prints complete, single-column and clutter-free without scrolling",
      async (entry) => {
        const print = await probe(entry.path, "print");
        expect(print.scrollY).toBe(0);
        expect(print.headerDisplay).toBe("none");
        expect(print.footerDisplay).toBe("none");
        expect(print.contentNavDisplay).toBe("none");
        expect(print.joinDisplay).toBe("none");
        expect(print.layoutDisplay === "grid" ? print.layoutColumns : 1).toBe(1);
        expect(rgbLuminance(print.themeBackground), "paper background").toBeGreaterThan(0.8);
        expect(rgbLuminance(print.answerColor), "answer ink").toBeLessThan(0.4);
        if (entry.kind === "rules") {
          expect(print.markerColor).not.toBeNull();
          expect(rgbLuminance(print.markerColor ?? ""), "marker ink").toBeLessThan(0.6);
        }
        if (entry.kind === "faq") {
          expect(print.faqSections).toHaveLength(FAQS.length);
          for (const section of print.faqSections ?? []) {
            expect(section.contentVisibility).toBe("visible");
            expect(section.height).toBeGreaterThan(0);
          }
          expect(print.faqFirstCardStacks).toBe(true);
          const destination = EXTERNAL_LINKS[0]?.href ?? "";
          const showsUrl =
            (print.externalAfterContent ?? "").includes(new URL(destination).hostname) ||
            (print.externalVisibleText ?? "").includes(destination);
          expect(showsUrl, "support destination printed as a URL").toBe(true);
        }
      },
    );

    it.each(pages)("$name renders to a real PDF", async (entry) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      try {
        const page = await context.newPage();
        await page.goto(`${base}${entry.path}`, { waitUntil: "load" });
        const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
        expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
        expect(pdf.length).toBeGreaterThan(5_000);
      } finally {
        await context.close();
      }
    });

    it("keeps the FAQ screen single-column with visible chrome at mobile width (both renderers)", async () => {
      for (const path of ["/faq", "/kit/faq"]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        try {
          const page = await context.newPage();
          await page.goto(`${base}${path}`, { waitUntil: "load" });
          const view = (await page.evaluate(() => {
            const layout = document.querySelector(".content-layout");
            const style = layout ? getComputedStyle(layout) : null;
            const header = document.querySelector(".site-header");
            return {
              columns: style ? style.gridTemplateColumns.split(" ").length : 0,
              display: style?.display ?? "",
              headerDisplay: header ? getComputedStyle(header).display : "missing",
            };
          })) as { columns: number; display: string; headerDisplay: string };
          expect(view.display === "grid" ? view.columns : 1).toBe(1);
          expect(view.headerDisplay).not.toBe("none");
        } finally {
          await context.close();
        }
      }
    });
  },
);
