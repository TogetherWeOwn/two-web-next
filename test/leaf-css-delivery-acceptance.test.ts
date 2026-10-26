// Acceptance: leaf-CSS delivery restructure — homepage screen-only bundle,
// leaf-only source seam (option B).
//
// Why: the leaf critical-CSS bundle is inlined byte-for-byte on "/" as well as
// the four content leaves, with ~89 B of inlined-CSS headroom at base, so any
// leaf-only CSS added to the shared sources (e.g. @media print rules for the
// reference pages) busts the homepage's hard byte caps
// (test/homepage-mobile-lcp-acceptance.test.ts, test/home-theme.test.ts).
// Raising those caps and shipping a print-only stylesheet were both refused;
// the chosen restructure splits delivery instead:
//
//   - public/styles.css + public/theme-tokens.css + public/theme.css stay the
//     SHARED sources; the homepage bundle is exactly their "\n" concatenation.
//   - A leaf-only source seam at assets/leaf-only.css (not a served
//     public/*.css, no budget or AUTHORED_CSS allowance, no stylesheet link)
//     is appended with the same "\n" join for the full leaf bundle only.
//   - The generator emits HOME_CRITICAL_CSS(+ _SHA256) into
//     src/home-critical-css.ts and LEAF_CRITICAL_CSS(+ _SHA256) into
//     src/leaf-critical-css.ts, each hash-allowlisted in CSP independently:
//     "/" carries only the homepage hash, leaves only the leaf hash.
//
// Named contract (the paired build implements exactly these names):
//   ci/build-leaf-css.mjs, invoked as `node ci/build-leaf-css.mjs`, regenerates
//     both modules (single command; the exports below are the oracle, the
//     generator's internal function names are not pinned).
//   Generated layout, mirroring the current leaf module exactly:
//     line 1: `// GENERATED from <inputs, comma+space> — do not hand-edit.`
//     line 2: `// Regen: node ci/build-leaf-css.mjs (drift is pinned by
//             test/leaf-css-delivery-acceptance.test.ts).`
//     then `export const <NAME>_CSS: string =\n  <JSON string>;\n` and
//          `export const <NAME>_CSS_SHA256: string = "<base64 sha256>";\n`
//   Inputs are public/styles.css, public/theme-tokens.css, public/theme.css
//   (both modules) plus assets/leaf-only.css (leaf module only), joined "\n".
//
// Screen-neutrality is pinned WITHOUT re-recording bytes: the live sources
// are recomputed as the oracle, @media print content is measured with a
// brace-matching stripper (non-vacuous by unit control), and the built
// homepage worker must keep its screen-applicable rule SHA-1 at the base
// pin recorded below. Byte caps are computed from the base formula, not new
// literals. The 1280x800 / 390x844 screenshot captures for "/" and the
// leaves stay the shipped visual-regression specs' job (CI-pinned pixels);
// this suite proves the bytes those specs render are unchanged on screen.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { securityHeadersFor } from "../src/headers";
// Mirroring homepage-mobile-lcp: the live-factory homepage bytes come from
// the lighthouse worker harness (ci/lighthouse-worker), never a replay stub.
import worker from "../ci/lighthouse-worker";
import type { Env } from "../src/env";
import app from "./app";

const repoRoot = new URL("../", import.meta.url);
const readRepo = (rel: string): string => readFileSync(new URL(rel, repoRoot), "utf8");

const SHARED_SOURCES = [
  "public/styles.css",
  "public/theme-tokens.css",
  "public/theme.css",
] as const;
const LEAF_ONLY_SOURCE = "assets/leaf-only.css";
const HOME_MODULE_PATH = "src/home-critical-css.ts";
const LEAF_MODULE_PATH = "src/leaf-critical-css.ts";

const sharedCss = SHARED_SOURCES.map((entry) => readRepo(entry)).join("\n");
const leafOnlyPath = new URL(LEAF_ONLY_SOURCE, repoRoot);
const leafOnlyCss = existsSync(leafOnlyPath) ? readRepo(LEAF_ONLY_SOURCE) : null;
const leafCss = leafOnlyCss === null ? null : `${sharedCss}\n${leafOnlyCss}`;

const sha256B64 = (css: string): string =>
  createHash("sha256").update(css, "utf8").digest("base64");
// Unknown until the seam source exists; "" never equals a real share, so
// every leaf assertion fails closed (and informatively) before the build.
const HOME_SHA = sha256B64(sharedCss);
const LEAF_SHA = leafCss === null ? "" : sha256B64(leafCss);

// Base screen-rule pins, measured at base 716154c6b: SHA-1 over the ordered,
// brace-match-extracted top-level rules of the shared sources that apply on
// screen (non-print). If a screen rule moves, rewrites or reorders, this
// changes; print-only additions to the leaf-only seam never touch it.
const BASE_SCREEN_RULES_SHA1 = "c6ca3fa83d3216ab023dcfd59ba651cf6bd6d7a0";
// Only the homepage pin sits on the live build path: leaf screen rules come
// from bytes already pinned against the live sources above, and a leaf pin
// over the full live app would drag the DB-bounded full suite (every route
// exceeds its per-suite database cap) into a CSS-delivery oracle.
const TOP_LEVEL_RULES = splitRules(sharedCss)
  .map((rule) => rule.trim())
  .filter((rule) => rule !== "");
const SCREEN_RULES = TOP_LEVEL_RULES.filter((rule) => {
  const normalized = rule.toLowerCase().replace(/\s+/g, " ").trim();
  return mediaTypeForRule(normalized) !== "print";
});
const SCREEN_RULES_SHA1 = createHash("sha1").update(SCREEN_RULES.join("")).digest("hex");

// --- minimal brace-matching helpers (string/comment aware) ------------------

// Index of the "}" that closes the block opened at `start` (css[start] ===
// "{"). String- and comment-aware so a "}" inside content or a comment never
// ends a rule early; braces only, since no brace can legally appear inside a
// CSS value outside a string in these sources.
function scanEnd(css: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  let comment = false;
  for (let i = start; i < css.length; i++) {
    const ch = css[i]!;
    const next = css[i + 1] ?? "";
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (comment) {
      if (ch === "*" && next === "/") {
        comment = false;
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      comment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

function splitRules(css: string): string[] {
  const rules: string[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) {
      if (css.slice(i).trim() !== "") rules.push(css.slice(i).trim());
      break;
    }
    const end = scanEnd(css, open);
    rules.push(css.slice(i, Math.min(end + 1, css.length)).trim());
    i = end + 1;
  }
  return rules;
}

// Classifies the @media rule (or null for non-media rules) by its type list.
// Leading comments are stripped first (a comment between rules attaches to
// the next rule's slice, and must not hide an @media print from the anchor).
// Comma-separated queries: any "print" part makes the whole rule print-bearing;
// the strip test removes such rules wholesale, which is the strict direction
// for "no @media print content on the homepage".
function mediaTypeForRule(normalized: string): "print" | "screen" | "other" | null {
  const uncommented = normalized.replace(/^(\/\*[\s\S]*?\*\/\s*)+/, "");
  const match = /^@media\b([^{]*)\{/.exec(uncommented);
  if (!match) return null;
  const query = match[1]!;
  const parts = query.split(",").map((part) => part.trim());
  const isPrint = (part: string) => /^((only|not)\s+)?print\b/.test(part);
  const isScreen = (part: string) => /^((only|not)\s+)?screen\b/.test(part);
  if (parts.some(isPrint)) return "print";
  if (parts.some(isScreen)) return "screen";
  return "other";
}

// Rule-level normalization: split + trim + join drops inter-rule whitespace,
// so cross-bundle comparisons always go through this form (never raw bytes).
function normalizeRules(css: string): string {
  return splitRules(css)
    .map((rule) => rule.trim())
    .filter((rule) => rule !== "")
    .join("");
}

function stripPrintRules(css: string): string {
  return normalizeRules(
    splitRules(css)
      .map((rule) => rule.trim())
      .filter((rule) => rule !== "")
      .filter((rule) => {
        const normalized = rule.toLowerCase().replace(/\s+/g, " ").trim();
        return mediaTypeForRule(normalized) !== "print";
      })
      .join(""),
  );
}

// --- generated-module parse -------------------------------------------------

type ParsedModule = { marker: string; css: string; sha256: string; regenLine: string } | null;

function parseGeneratedModule(rel: string, name: "HOME" | "LEAF"): ParsedModule {
  const path = new URL(rel, repoRoot);
  if (!existsSync(path)) return null;
  const source = readRepo(rel);
  const lines = source.split("\n");
  const cssMatch = new RegExp(
    `export const ${name}_CRITICAL_CSS: string =\\n {2}("(?:[^"\\\\]|\\\\.)*");`,
  ).exec(source);
  const hashMatch = new RegExp(
    `export const ${name}_CRITICAL_CSS_SHA256: string = "([^"]+)";`,
  ).exec(source);
  if (!cssMatch || !hashMatch) return null;
  return {
    marker: lines[0] ?? "",
    regenLine: lines[1] ?? "",
    css: JSON.parse(cssMatch[1]!) as string,
    sha256: hashMatch[1]!,
  };
}

// --- runtime fixtures ---------------------------------------------------------

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
  RULES_LAST_UPDATED: "2026-09-01",
};

const LEAF_PATHS = ["/about", "/faq", "/rules", "/privacy"] as const;

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("leaf-CSS delivery tests must remain offline");
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function servedPage(path: string): Promise<{ html: string; csp: string; status: number }> {
  const response = await app.request(path, {}, env);
  return {
    status: response.status,
    html: await response.text(),
    csp: response.headers.get("content-security-policy") ?? "",
  };
}

function styleBlock(html: string): string | null {
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  return match ? match[1]! : null;
}

// --- the contract ---------------------------------------------------------------

describe("leaf-CSS delivery: two hash-allowlisted bundles from one generator", () => {
  it("generates a screen-only homepage bundle from exactly the three shared sources", () => {
    const home = parseGeneratedModule(HOME_MODULE_PATH, "HOME");
    expect(home, `${HOME_MODULE_PATH} must exist with HOME_CRITICAL_CSS exports`).not.toBeNull();
    expect(home!.marker).toBe(`// GENERATED from ${SHARED_SOURCES.join(", ")} — do not hand-edit.`);
    expect(home!.regenLine).toBe(
      "// Regen: node ci/build-leaf-css.mjs (drift is pinned by test/leaf-css-delivery-acceptance.test.ts).",
    );
    expect(home!.css).toBe(sharedCss);
    expect(home!.sha256).toBe(HOME_SHA);
    expect(home!.css).not.toMatch(/<\/style/i);
  });

  it("generates the full leaf bundle from the shared sources plus the leaf-only seam", () => {
    const leaf = parseGeneratedModule(LEAF_MODULE_PATH, "LEAF");
    expect(leaf, `${LEAF_MODULE_PATH} must exist with LEAF_CRITICAL_CSS exports`).not.toBeNull();
    expect(leaf!.marker).toBe(
      `// GENERATED from ${[...SHARED_SOURCES, LEAF_ONLY_SOURCE].join(", ")} — do not hand-edit.`,
    );
    expect(leaf!.regenLine).toBe(
      "// Regen: node ci/build-leaf-css.mjs (drift is pinned by test/leaf-css-delivery-acceptance.test.ts).",
    );
    expect(leafCss, `${LEAF_ONLY_SOURCE} (leaf-only seam source) must exist`).not.toBeNull();
    expect(leaf!.css).toBe(leafCss);
    expect(leaf!.sha256).toBe(LEAF_SHA);
    expect(leaf!.css).not.toMatch(/<\/style/i);
  });

  it("keeps the two bundles distinct so the homepage never guesses the leaf bytes", () => {
    expect(leafCss).not.toBeNull();
    // Even with an empty seam the "\n" join keeps the bundles byte-distinct;
    // a builder that aliases HOME to LEAF (or vice versa) collapses the
    // hashes and this fails.
    expect(LEAF_SHA).not.toBe("");
    expect(LEAF_SHA).not.toBe(HOME_SHA);
    expect(leafCss!.startsWith(sharedCss)).toBe(true);
    expect(leafCss).not.toBe(sharedCss);
  });

  it("recorded bytes recompute to the recorded hashes (no trust in the constants)", () => {
    const home = parseGeneratedModule(HOME_MODULE_PATH, "HOME");
    const leaf = parseGeneratedModule(LEAF_MODULE_PATH, "LEAF");
    expect(home).not.toBeNull();
    expect(leaf).not.toBeNull();
    expect(sha256B64(home!.css)).toBe(home!.sha256);
    expect(sha256B64(leaf!.css)).toBe(leaf!.sha256);
  });
});

describe("leaf-CSS delivery: leaf-only seam is a source, never a served stylesheet", () => {
  it("feeds the leaf bundle from outside public/ with its bytes trailing the shared sources", () => {
    expect(leafOnlyCss, `${LEAF_ONLY_SOURCE} must exist as the leaf-only seam`).not.toBeNull();
    expect(existsSync(new URL("public/leaf-only.css", repoRoot))).toBe(false);
    expect(leafCss).toBe(`${sharedCss}\n${leafOnlyCss}`);
  });

  it("adds no served stylesheet, no budget entry and no AUTHORED_CSS allowance", () => {
    const publicCss = readdirSync(new URL("public", repoRoot))
      .filter((entry) => entry.endsWith(".css"))
      .map((entry) => `public/${entry}`)
      .sort();
    const expectedPublic = [
      "public/admin-rsvp-review.css",
      "public/event-theme.css",
      "public/profile-theme.css",
      "public/schedule-theme.css",
      "public/styles.css",
      "public/theme-tokens.css",
      "public/theme.css",
    ].sort();
    expect(publicCss).toEqual(expectedPublic);
    const budgets: Record<string, unknown> = {};
    for (const entry of readdirSync(new URL("ci/budgets/bundle", repoRoot))) {
      if (!entry.endsWith(".json")) continue;
      const fragment = JSON.parse(readRepo(`ci/budgets/bundle/${entry}`)) as {
        budgets: Record<string, unknown>;
      };
      Object.assign(budgets, fragment.budgets);
    }
    for (const key of Object.keys(budgets)) {
      expect(key.endsWith(".css") && !expectedPublic.includes(key), key).toBe(false);
    }
    const minify = readRepo("ci/minify-assets.mjs");
    const authored = /AUTHORED_CSS = new Set\(\[([\s\S]*?)\]\)/.exec(minify);
    expect(authored).not.toBeNull();
    const entries = [...authored![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(entries).toEqual(
      [
        "public/event-theme.css",
        "public/profile-theme.css",
        "public/schedule-theme.css",
        "public/theme-tokens.css",
        "public/theme.css",
      ].sort(),
    );
    expect(minify).not.toContain("leaf-only");
  });

  it("ships no stylesheet link for the seam on the homepage or any leaf", async () => {
    for (const path of ["/", ...LEAF_PATHS]) {
      const { html } = await servedPage(path);
      expect(html, path).not.toContain("leaf-only");
      expect(html, path).not.toContain('rel="stylesheet"');
    }
  });
});

describe("leaf-CSS delivery: each path inlines only its own bundle", () => {
  it('"/" inlines the homepage bundle only, font preload ahead of the style block', async () => {
    const { html, status } = await servedPage("/");
    expect(status).toBe(200);
    expect(styleBlock(html)).toBe(sharedCss);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toMatch(/<link(?=[^>]*rel="preload")(?=[^>]*as="style")/);
    const preload = html.indexOf('href="/fonts/display-latin-700.woff2" as="font"');
    const style = html.indexOf("<style>");
    expect(preload).toBeGreaterThanOrEqual(0);
    expect(style).toBeGreaterThanOrEqual(0);
    expect(preload).toBeLessThan(style);
  });

  it.each(LEAF_PATHS)("%s inlines the full leaf bundle only", async (path) => {
    const { html, status } = await servedPage(path);
    expect(status).toBe(200);
    expect(leafCss, `${LEAF_ONLY_SOURCE} must exist`).not.toBeNull();
    expect(styleBlock(html)).toBe(leafCss);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toMatch(/<link(?=[^>]*rel="preload")(?=[^>]*as="style")/);
    expect(html).not.toContain('.woff2" as="font"');
  });

  it("keeps recovery/error shells on external stylesheets with no inline hash", async () => {
    const response = await app.request("/missing-page", {}, env);
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('rel="stylesheet" href="/styles.css"');
    expect(html).not.toContain("<style>");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("sha256-");
  });
});

describe("leaf-CSS delivery: CSP is per-path on both emission paths", () => {
  it('"/" carries exactly the homepage hash (served and framework-neutral builder)', async () => {
    const { csp } = await servedPage("/");
    expect(csp).toContain(`style-src 'self' 'sha256-${HOME_SHA}'`);
    expect(csp).not.toContain("unsafe-inline");
    if (LEAF_SHA !== "") expect(csp).not.toContain(`sha256-${LEAF_SHA}`);
    const built = new Map(securityHeadersFor({ path: "/", method: "GET" })).get(
      "Content-Security-Policy",
    );
    expect(built).toContain(`style-src 'self' 'sha256-${HOME_SHA}'`);
    if (LEAF_SHA !== "") expect(built).not.toContain(`sha256-${LEAF_SHA}`);
    // Both emission paths agree on the full policy, not just the directive.
    expect(built).toBe(csp);
  });

  it.each(LEAF_PATHS)(
    "%s carries exactly the leaf hash (served and framework-neutral builder)",
    async (path) => {
      expect(LEAF_SHA, `${LEAF_ONLY_SOURCE} must exist`).not.toBe("");
      const { csp } = await servedPage(path);
      expect(csp).toContain(`style-src 'self' 'sha256-${LEAF_SHA}'`);
      expect(csp).not.toContain(`sha256-${HOME_SHA}`);
      expect(csp).not.toContain("unsafe-inline");
      const built = new Map(securityHeadersFor({ path, method: "GET" })).get(
        "Content-Security-Policy",
      );
      expect(built).toContain(`style-src 'self' 'sha256-${LEAF_SHA}'`);
      expect(built).not.toContain(`sha256-${HOME_SHA}`);
      expect(built).toBe(csp);
    },
  );

  it("leaves every non-inline path on the exact documented style-src", async () => {
    for (const path of ["/join", "/events", "/missing-page"]) {
      const built = new Map(securityHeadersFor({ path, method: "GET" })).get(
        "Content-Security-Policy",
      )!;
      expect(built, path).toMatch(/style-src 'self';/);
      expect(built, path).not.toContain("sha256-");
      expect(built, path).not.toContain("unsafe-inline");
      const { csp } = await servedPage(path);
      expect(csp, path).toBe(built);
    }
  });
});

describe("leaf-CSS delivery: hard caps hold with constants unmodified", () => {
  it("keeps the homepage inline-CSS cap: shared bytes stay under 18,850 B", () => {
    // The cap literal lives in test/homepage-mobile-lcp-acceptance.test.ts
    // (24800 HTML / 18850 inlined CSS); this is the formula re-derivation:
    // the homepage bundle is the shared sources only, sized against the cap.
    const bytes = Buffer.byteLength(sharedCss, "utf8");
    expect(bytes).toBeLessThanOrEqual(18850);
    expect(bytes).toBeGreaterThan(0);
    expect(leafCss).not.toBeNull();
    // The trap this slice exists to disarm: leaf-only bytes live outside the
    // homepage bundle, so even a grown seam cannot eat the homepage margin.
    expect(Buffer.byteLength(leafCss!, "utf8")).toBeGreaterThanOrEqual(bytes);
  });

  it("keeps public/theme.css under 13,000 chars (leaf-only rules never grow it)", () => {
    expect(readRepo("public/theme.css").length).toBeLessThan(13000);
  });
});

describe("leaf-CSS delivery: screen rendering is unchanged", () => {
  it("matches the base screen-rule pin (no screen rule moved, rewrote or reordered)", () => {
    expect(SCREEN_RULES_SHA1).toBe(BASE_SCREEN_RULES_SHA1);
  });

  it("proves the strip control is non-vacuous before judging live bundles", () => {
    const probe = "p{color:red}@media print{p{color:#000}}h1{margin:0}";
    expect(stripPrintRules(probe)).toBe("p{color:red}h1{margin:0}");
    // The split must actually see the live sources, and the shared sources
    // must stay screen-only after the restructure: print rules belong in the
    // leaf-only seam, never here (that is what keeps "/" under its caps).
    expect(splitRules(sharedCss).length).toBeGreaterThan(100);
    expect(stripPrintRules(sharedCss)).toBe(normalizeRules(sharedCss));
  });

  it("serves zero @media print content anywhere on the homepage", async () => {
    const { html } = await servedPage("/");
    const block = styleBlock(html);
    expect(block).not.toBeNull();
    expect(stripPrintRules(block!)).toBe(normalizeRules(block!));
  });

  it("strips @media print case-insensitively (mutated-copy control, never live bytes)", () => {
    const mutated = `${sharedCss}@MEDIA PRINT{.acceptance-probe{color:#000}}`;
    expect(stripPrintRules(mutated)).toBe(stripPrintRules(sharedCss));
    const commented = `${sharedCss}/* print rules */ @media print{.acceptance-probe{color:#000}}`;
    expect(stripPrintRules(commented)).toBe(stripPrintRules(sharedCss));
  });

  it.each(LEAF_PATHS)(
    "%s screen bytes equal the shared sources after removing print-only rules",
    async (path) => {
      const { html } = await servedPage(path);
      const block = styleBlock(html);
      expect(block).not.toBeNull();
      expect(stripPrintRules(block!)).toBe(stripPrintRules(sharedCss));
    },
  );

  it("live homepage worker: one style block, base screen rules, no print content", async () => {
    const context = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const response = await worker.fetch(
      new Request("http://127.0.0.1:8787/"),
      {
        DATABASE_URL: "postgres://must-not-connect.invalid/forbidden",
        DB: { connectionString: "postgres://must-not-connect.invalid/forbidden" },
        DISCORD_BOT_TOKEN: "must-not-use",
      },
      context,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('rel="stylesheet"');
    const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(blocks).toHaveLength(1);
    const css = blocks[0]![1]!;
    expect(stripPrintRules(css)).toBe(normalizeRules(css));
    const liveScreenRules = splitRules(css)
      .map((rule) => rule.trim())
      .filter((rule) => rule !== "")
      .filter((rule) => {
        const normalized = rule.toLowerCase().replace(/\s+/g, " ").trim();
        return mediaTypeForRule(normalized) !== "print";
      });
    expect(createHash("sha1").update(liveScreenRules.join("")).digest("hex")).toBe(
      BASE_SCREEN_RULES_SHA1,
    );
  });
});
