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
// How to satisfy the red tests (smallest change): unify the hero strap to
// Display 700 and drop the now-dead 500 @font-face from public/theme.css,
// then regen the leaf bundle (node ci/build-leaf-css.mjs). The drift test,
// the CSP hash and the home-inline-css pins follow the regenerated constant.
// The strap selector also styles non-home hero straps, so the fix needs the
// UI-loop visual evidence (desktop + mobile screenshots) before merge.

const require = createRequire(import.meta.url);
const lighthouserc = require("../ci/lighthouserc.cjs").ci;

// Tight ratchets (<100 B slack): the Lobby Ember brand re-baselined both.
// Measured 37,488 B HTML / 25,017 B inlined CSS. The HTML growth is the
// inline header lockup + mobile icon SVGs (~6.5 KB, kept byte-verbatim from
// the brand kit so the vectors stay diffable), the CSS growth below, and
// ~0.5 KB of OG/favicon/preload head tags. The CSS growth is the full
// brand token contract (~5.0 KB: ramps, semantics, gradients, schedule
// variant) plus four @font-face faces, Inter body scoping and lockup
// rules (~1.2 KB), partly offset by the shorter var(--two-font-*)
// stacks. Gzip is deliberately not asserted: the repetitive face bytes
// compress away, so a gzip ratchet would be noise.
const MAX_HOMEPAGE_HTML_RAW_BYTES = 37550;
const MAX_HOMEPAGE_INLINE_CSS_RAW_BYTES = 25100;

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

  it("retains exactly one font preload (Chakra Petch 700): never add a second preload as a fix", async () => {
    const { html } = await homepageHtml();
    const preloads = [...html.matchAll(/<link[^>]*as="font"[^>]*>/g)].map((m) => m[0]);
    expect(preloads).toHaveLength(1);
    expect(preloads[0]).toContain("/fonts/chakra-petch-latin-700-normal.woff2");
  });

  it("retains the Display Fallback swap chain for delayed font swaps", async () => {
    const { html } = await homepageHtml();
    const css = inlineCss(html);
    expect(css).toContain("@font-face { font-family: 'Display Fallback'");
    expect(css).toContain("size-adjust: 98%");
    expect(css).toContain("ascent-override: 103%");
    expect(css).toContain("descent-override: 32%");
  });

  it("keeps homepage images non-blocking and the inline lockup sized", async () => {
    const { html } = await homepageHtml();
    for (const match of html.matchAll(/<img\b[^>]*>/g)) {
      const img = match[0];
      // Fixture featured rows carry no image, but any featured image must
      // stay lazy/async/sized.
      if (img.includes('class="featured-image"')) {
        expect(img).toContain('loading="lazy"');
        expect(img).toContain('decoding="async"');
      }
      expect(img).toMatch(/width="[0-9]+"/);
      expect(img).toMatch(/height="[0-9]+"/);
    }
    // The header lockup is inline SVG (no fetch above the fold): explicit
    // dimensions on both variants so neither shifts layout.
    expect(html).toContain('<svg width="180" height="50" class="brand-lockup"');
    expect(html).toContain('<svg width="40" height="40" class="brand-icon"');
  });

  it("serves a single Display weight: no 500 face fetch on the funnel top", async () => {
    // Only `.hero .strap` uses Display 500, so the homepage fetches a second
    // 15,084 B font (display-latin-500.woff2) that is discovered late via CSS
    // instead of the 700 preload. Unify the strap to 700 and drop the dead
    // face: one critical font fetch instead of two.
    const { html } = await homepageHtml();
    expect(inlineCss(html)).not.toContain("display-latin-500");
  });

  it("sets no exact Display 500 weight on the homepage", async () => {
    // Companion to the face test: dropping the face while keeping the 500
    // usage would leave the strap on synthesized/fallback rendering and
    // invite the face back. The semicolon scopes this to exact-weight
    // declarations (the strap rule, the 500 face): the retained
    // 'Display Fallback' range face (`font-weight: 500 700;`) still passes.
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
