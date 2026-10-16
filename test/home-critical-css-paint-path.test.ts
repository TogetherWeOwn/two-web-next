// Acceptance tests for the homepage critical-CSS paint path (Land #917).
//
// Paint-path invariant: "/" inlines the shared leaf critical-CSS bundle and
// drops every render-blocking request (stylesheets + Display-700 preload), so
// first paint needs zero blocking fetches. The inline block stays
// hash-allowlisted in `style-src` (no `unsafe-inline`), and recovery/error
// shells keep external stylesheets so the allowlist scope stays narrow.
//
// These tests fail on main (homepage still links external stylesheets with a
// font preload under a self-only `style-src`) and pass once the perf change
// lands. Test files only; production code untouched. Budget floors are pinned
// below so this card cannot loosen them.
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import { pageShellFixture } from "./helpers/page-shells";

const require = createRequire(import.meta.url);

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("paint-path acceptance tests must remain offline");
    }),
  ),
);
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("homepage critical-CSS paint path", () => {
  it('inlines the shared leaf bundle on "/" with the hero rules', async () => {
    const response = await pageShellFixture().request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).toContain(".hero h1");
  });

  it('drops every render-blocking request on "/" (no stylesheets, no font preload)', async () => {
    const html = await (await pageShellFixture().request("/")).text();
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toContain('.woff2" as="font"');
  });

  it('serves "/" under a hash-allowlisted CSP with no unsafe-inline', async () => {
    const response = await pageShellFixture().request("/");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
    expect(csp).not.toContain("unsafe-inline");
  });

  it("keeps recovery shells on external stylesheets without the inline hash", async () => {
    const response = await pageShellFixture().request("/missing-page");
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('rel="stylesheet" href="/styles.css"');
    expect(html).not.toContain("<style>");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("sha256-");
  });

  it("leaves the Lighthouse/budget floors untouched", () => {
    const budget = require("../ci/quality-budget.json");
    expect(budget.mobilePerformance).toBe(0.9);
    expect(budget.categories.performance).toBe(0.9);
    const config = require("../ci/lighthouserc.cjs").ci;
    expect(config.collect.url).toContain("http://127.0.0.1:8787/");
    expect(config.assert.assertions["categories:performance"][1].minScore).toBe(
      budget.mobilePerformance,
    );
  });
});
