import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import worker from "../ci/lighthouse-worker";

// Acceptance: homepage mobile LCP regression (staging incident).
//
// Ground truth (staging e2e-staging on main, mobile budgets vs 2000 ms on `/`):
//   run 39419198475 @ 4969d9d: median 2129.9795 ms (3/3 samples over)
//   run 39518777183 @ cb97e54: median 2161.5525 ms (3/3 samples over)
// 6/6 samples over budget across two SHAs: systematic headroom loss, not variance.
// Full table: the staging QA evidence document. Paired build: the paired homepage-mobile-LCP build card.
//
// Local-fidelity finding (measured 2026-10-21, this branch base):
// a single mobile Lighthouse run against the local fixture worker
// (ci/wrangler.lighthouse.jsonc, simulate throttling, 412x823, 4x CPU)
// reports `/` LCP 1059 ms with performance score 1.0: the fixture passes
// with ~940 ms headroom, so the sandbox cannot reproduce the staging breach
// (loopback TTFB ~12 ms vs staging ~200-570 ms, fixture content vs real
// content, no CDN challenge script). No local Lighthouse red test is possible;
// the staging `e2e-staging` mobile budget on `/` remains the final acceptance.
// These tests pin the closest deterministic coverage instead: the staging
// budget contract (never loosened) plus the demonstrable critical-path waste
// on the served homepage (a second Display font weight fetched for one rule)
// with tight weight ratchets sized so that fix alone satisfies them.
//
// Owned paths (Builder builds on this branch and never edits this file):
//   test/homepage-mobile-lcp-acceptance.test.ts
//
// How to satisfy the red tests (smallest change): point the single font
// preload at the variable Mona Sans file, carry its metric-matched fallback
// numbers, then regen the leaf bundle (node ci/build-leaf-css.mjs). The
// drift test, the CSP hash and the home-inline-css pins follow the
// regenerated constant. A strap selector change also styles non-home hero
// straps, so the fix needs the UI-loop visual evidence (desktop + mobile
// screenshots) before merge.

const require = createRequire(import.meta.url);
const lighthouserc = require("../ci/lighthouserc.cjs").ci;

// Homepage weight ratchets after the Ember Hours token migration. Section-3
// (#2031) re-measured bytes plus 200 B slack were HTML 27376 / CSS 21343.
// Ember re-measures (the two static Display faces and their fallback collapse
// into one variable Mona Sans face plus its local-metric fallback; the token
// sheet is rewritten to kit literals): HTML 27176 -> 26532 raw bytes (gzip
// 7378 -> 7335, informational); inlined critical CSS 21143 -> 20497 raw
// bytes (gzip 5330 -> 5280, informational). Attribution, all inside the
// inlined leaf bundle: the two Display @font-face blocks plus the Display
// Fallback face collapse into the variable Mona face and its local fallback
// (-646 CSS, -644 HTML; the 2 B gap is the longer preload filename). The
// budgets below are those re-measured bytes plus 200 B slack; they stop later
// changes from regrowing homepage weight while LCP headroom is being
// restored. Gzip stays informational: it compresses the repetitive face
// bytes away, so a gzip ratchet would be noise. (The brand unfurl tags add
// a constant 154 raw bytes to every canonical page, already included on
// both sides of this derivation.)
const MAX_HOMEPAGE_HTML_RAW_BYTES = 26732;
const MAX_HOMEPAGE_INLINE_CSS_RAW_BYTES = 20697;

const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

async function homepageHtml(): Promise<{ status: number; html: string }> {
  // Same HTML the local Lighthouse job measures (ci/lighthouse-worker),
  // with live bindings forbidden: local fixtures only, no staging/prod.
  const response = await worker.fetch(
    new Request("http://127.0.0.1:8787/"),
    {
      DATABASE_URL: "postgres://must-not-connect.invalid/forbidden",
      DB: { connectionString: "postgres://must-not-connect.invalid/forbidden" },
      DISCORD_BOT_TOKEN: "must-not-use",
    },
    context,
  );
  return { status: response.status, html: await response.text() };
}

function inlineCss(html: string): string {
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  expect(match, "homepage carries the inlined critical-CSS bundle").not.toBeNull();
  return match![1]!;
}

describe("homepage mobile LCP acceptance", () => {
  it("pins the 2000 ms mobile LCP budget: the budget stays, the page gets faster", () => {
    // Anti-loosening pin: clearing the incident by raising maxNumericValue
    // (or weakening the aggregation) fails here instead of shipping.
    expect(lighthouserc.assert.assertions["largest-contentful-paint"]).toEqual([
      "error",
      { maxNumericValue: 2000, aggregationMethod: "median" },
    ]);
  });

  it("measures the populated fixture homepage, never a fallback", async () => {
    const outbound = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected outbound fetch"));
    try {
      const { status, html } = await homepageHtml();
      expect(status).toBe(200);
      expect(html).toContain('data-testid="home-events-list"');
      expect(html).toContain('data-testid="featured-content"');
      expect(html).toContain("Lighthouse fixture community news");
      expect(html).not.toContain('data-testid="home-events-empty"');
      expect(html).not.toContain('data-state="unavailable"');
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      outbound.mockRestore();
    }
  });

  it("keeps zero render-blocking stylesheets on /", async () => {
    const { html } = await homepageHtml();
    expect(html).not.toContain('rel="stylesheet"');
    expect(inlineCss(html)).toContain(".hero h1");
  });

  it("retains exactly one font preload (Mona Sans variable): never add a second preload as a fix", async () => {
    const { html } = await homepageHtml();
    const preloads = [...html.matchAll(/<link[^>]*as="font"[^>]*>/g)].map((m) => m[0]);
    expect(preloads).toHaveLength(1);
    expect(preloads[0]).toContain("/fonts/mona-sans-latin-var.woff2");
  });

  it("retains the Mona Sans Fallback swap chain for delayed font swaps", async () => {
    const { html } = await homepageHtml();
    const css = inlineCss(html);
    // Served CSS is generated and minified: allow whitespace and optional quotes.
    expect(css).toMatch(/@font-face\s*\{\s*font-family:\s*["']?Mona Sans Fallback["']?\s*;/);
    expect(css).toMatch(/size-adjust:\s*103\.33%/);
    expect(css).toMatch(/ascent-override:\s*105\.49%/);
    expect(css).toMatch(/descent-override:\s*30\.97%/);
    expect(css).toMatch(/font-weight:\s*200 900/);
    expect(css).toMatch(
      /--font-display:\s*Mona Sans,\s*["']Mona Sans Fallback["'],\s*system-ui,\s*sans-serif/,
    );
  });

  it("keeps homepage images non-blocking and sized", async () => {
    const { html } = await homepageHtml();
    for (const match of html.matchAll(/<img\b[^>]*>/g)) {
      const img = match[0];
      // The header logo is above the fold; fixture featured rows carry no
      // image, but any featured image must stay lazy/async/sized.
      if (img.includes('class="featured-image"')) {
        expect(img).toContain('loading="lazy"');
        expect(img).toContain('decoding="async"');
      }
      expect(img).toMatch(/width="[0-9]+"/);
      expect(img).toMatch(/height="[0-9]+"/);
    }
    expect(html).toContain("<img");
  });

  it("serves a single variable display face: no static second-weight fetch on the funnel top", async () => {
    // The retired static Display 500 face (display-latin-500.woff2) was
    // discovered late via CSS instead of the preload. One variable Mona Sans
    // face (wght 200-900) covers every weight from the single preload, so no
    // static second face may return: one critical font fetch instead of two.
    const { html } = await homepageHtml();
    expect(inlineCss(html)).not.toContain("display-latin-500");
    expect(inlineCss(html)).toContain("mona-sans-latin-var.woff2");
  });

  it("sets no exact 500 weight on the homepage", async () => {
    // Companion to the face test: the variable face covers 200-900 from the
    // single preload, so an exact-weight declaration cannot summon a second
    // fetch — but it would signal a static-face regression or synthesized
    // rendering. The semicolon scopes this to exact-weight declarations: the
    // variable range face (`font-weight: 200 900;`) still passes.
    const { html } = await homepageHtml();
    expect(inlineCss(html)).not.toContain("font-weight: 500;");
  });

  it("ratchets homepage HTML raw weight below current main", async () => {
    const { html } = await homepageHtml();
    const raw = Buffer.byteLength(html, "utf8");
    expect(
      raw,
      `homepage HTML raw bytes: ${raw} > ${MAX_HOMEPAGE_HTML_RAW_BYTES} (gzip ${gzipSync(html).length} B, informational)`,
    ).toBeLessThanOrEqual(MAX_HOMEPAGE_HTML_RAW_BYTES);
  });

  it("ratchets inlined critical-CSS raw weight below current main", async () => {
    const { html } = await homepageHtml();
    const css = inlineCss(html);
    const raw = Buffer.byteLength(css, "utf8");
    expect(
      raw,
      `inlined CSS raw bytes: ${raw} > ${MAX_HOMEPAGE_INLINE_CSS_RAW_BYTES} (gzip ${gzipSync(css).length} B, informational)`,
    ).toBeLessThanOrEqual(MAX_HOMEPAGE_INLINE_CSS_RAW_BYTES);
  });
});
