import { describe, expect, it } from "vitest";
import { HOME_CRITICAL_CSS, HOME_CRITICAL_CSS_SHA256 } from "../src/home-critical-css";
import { LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";
import { pageShellFixture } from "./helpers/page-shells";

// Homepage paint path: "/" inlines the homepage critical-CSS bundle (the three
// shared sources only — leaf-only rules ride the separate leaf bundle, so
// they can never grow "/" against its byte caps) while retaining the
// Display-700 preload for an early font fetch; the Arial-metric
// 'Display Fallback' limits layout changes during delayed swaps.
// Recovery/error shells keep theme="home" without the flag and stay external.
describe("homepage inlined critical CSS", () => {
  it("inlines critical CSS and retains the font preload on the flagged home shell", () => {
    const html = Layout({ title: "Fixture", theme: "home", inlineCriticalCss: true })!.toString();
    expect(html).toContain(`<style>${HOME_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
  });

  it("keeps the unflagged home shell on external stylesheets with the preload", () => {
    const html = Layout({ title: "Fixture", theme: "home" })!.toString();
    expect(html).toContain('rel="stylesheet" href="/styles.css"');
    expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
    expect(html).not.toContain("<style>");
  });

  it('serves "/" inlined under a hash-allowlisted CSP', async () => {
    const response = await pageShellFixture().request("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<style>${HOME_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain('href="/fonts/display-latin-700.woff2" as="font"');
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`style-src 'self' 'sha256-${HOME_CRITICAL_CSS_SHA256}'`);
    expect(csp).not.toContain(`sha256-${LEAF_CRITICAL_CSS_SHA256}`);
    expect(csp).not.toContain("unsafe-inline");
  });

  it("uses an Arial-metric fallback ahead of Arial Narrow for delayed font swaps", () => {
    // The preload alone cannot close the cold-mobile FCP/font gap; the
    // size-adjusted fallback uses the measured uppercase heading ratio.
    // Ascent/descent overrides normalize to Display's 93%/34.6% em metrics
    // (at the 77% size-adjust) plus margin, so the fallback hero paints at
    // least as large as the swapped-in text and the swap is not a larger
    // repaint that re-times LCP after FCP.
    expect(HOME_CRITICAL_CSS).toContain("@font-face { font-family: 'Display Fallback'");
    expect(HOME_CRITICAL_CSS).toContain("local('Liberation Sans'), local('Arimo'), local('Arial')");
    expect(HOME_CRITICAL_CSS).toContain("size-adjust: 77%");
    expect(HOME_CRITICAL_CSS).toContain("ascent-override: 123%");
    expect(HOME_CRITICAL_CSS).toContain("descent-override: 46%");
    expect(HOME_CRITICAL_CSS).toContain("line-gap-override: 0%");
    expect(HOME_CRITICAL_CSS).toContain("Display, 'Display Fallback', 'Arial Narrow'");
    expect(HOME_CRITICAL_CSS).not.toMatch(/Display, 'Arial Narrow'/);
    const html = Layout({ title: "Fixture", theme: "home", inlineCriticalCss: true })!.toString();
    expect(html).toContain("'Display Fallback'");
  });

  it("emits the Display-700 preload before the inlined style block", async () => {
    // Staging forensics: the font was discovered at document-end + ~25 ms in
    // every mobile sample (the preload sat after ~19 KB of inline CSS), so the
    // simulated font completion hovered at the paint boundary and flipped `/`
    // LCP between FCP and FCP + ~450 ms. Early discovery keeps LCP at FCP.
    const assertPreloadBeforeStyle = (html: string) => {
      const preload = html.indexOf('href="/fonts/display-latin-700.woff2" as="font"');
      const style = html.indexOf("<style>");
      expect(preload).toBeGreaterThanOrEqual(0);
      expect(style).toBeGreaterThanOrEqual(0);
      expect(preload).toBeLessThan(style);
    };
    assertPreloadBeforeStyle(
      String(Layout({ title: "Fixture", theme: "home", inlineCriticalCss: true })),
    );
    const servedResponse = await pageShellFixture().request("/");
    assertPreloadBeforeStyle(await servedResponse.text());
  });

  it("keeps recovery home-theme shells on external stylesheets without the hash", async () => {
    const response = await pageShellFixture().request("/missing-page");
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('rel="stylesheet" href="/styles.css"');
    expect(html).not.toContain("<style>");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain("sha256-");
  });
});
