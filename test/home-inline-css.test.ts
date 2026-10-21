import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";
import { pageShellFixture } from "./helpers/page-shells";

// Homepage paint path: "/" reuses the leaf critical-CSS bundle inline while
// retaining the Chakra Petch 700 preload for an early font fetch; the
// Arial-metric 'Display Fallback' limits layout changes during delayed swaps.
// Recovery/error shells keep theme="home" without the flag and stay external.
describe("homepage inlined critical CSS", () => {
  it("inlines critical CSS and retains the font preload on the flagged home shell", () => {
    const html = Layout({ title: "Fixture", theme: "home", inlineCriticalCss: true })!.toString();
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain('href="/fonts/chakra-petch-latin-700-normal.woff2" as="font"');
  });

  it("keeps the unflagged home shell on external stylesheets with the preload", () => {
    const html = Layout({ title: "Fixture", theme: "home" })!.toString();
    expect(html).toContain('rel="stylesheet" href="/styles.css"');
    expect(html).toContain('href="/fonts/chakra-petch-latin-700-normal.woff2" as="font"');
    expect(html).not.toContain("<style>");
  });

  it('serves "/" inlined under a hash-allowlisted CSP', async () => {
    const response = await pageShellFixture().request("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain('href="/fonts/chakra-petch-latin-700-normal.woff2" as="font"');
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
    expect(csp).not.toContain("unsafe-inline");
  });

  it("uses an Arial-metric fallback ahead of Arial Narrow for delayed font swaps", () => {
    // The preload alone cannot close the cold-mobile FCP/font gap; the
    // size-adjusted fallback uses the measured uppercase heading ratio.
    // Ascent/descent overrides normalize to Display's 93%/34.6% em metrics
    // (at the 77% size-adjust) plus margin, so the fallback hero paints at
    // least as large as the swapped-in text and the swap is not a larger
    // repaint that re-times LCP after FCP.
    expect(LEAF_CRITICAL_CSS).toContain("@font-face { font-family: 'Display Fallback'");
    expect(LEAF_CRITICAL_CSS).toContain("local('Liberation Sans'), local('Arimo'), local('Arial')");
    expect(LEAF_CRITICAL_CSS).toContain("size-adjust: 77%");
    expect(LEAF_CRITICAL_CSS).toContain("ascent-override: 123%");
    expect(LEAF_CRITICAL_CSS).toContain("descent-override: 46%");
    expect(LEAF_CRITICAL_CSS).toContain("line-gap-override: 0%");
    expect(LEAF_CRITICAL_CSS).toContain("var(--two-font-display");
    expect(LEAF_CRITICAL_CSS).toContain(
      '"Chakra Petch", "Display", "Display Fallback", "Arial Narrow"',
    );
    expect(LEAF_CRITICAL_CSS).not.toMatch(/"Display", "Arial Narrow"/);
    const html = Layout({ title: "Fixture", theme: "home", inlineCriticalCss: true })!.toString();
    expect(html).toContain("'Display Fallback'");
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
