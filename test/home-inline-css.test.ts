import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";
import { pageShellFixture } from "./helpers/page-shells";

// Homepage paint path: "/" reuses the leaf critical-CSS bundle inline while
// retaining the Mona Sans variable preload for an early font fetch; the
// Arimo-metric 'Mona Sans Fallback' limits layout changes during delayed swaps.
// Recovery/error shells keep theme="home" without the flag and stay external.
describe("homepage inlined critical CSS", () => {
  it("inlines critical CSS and retains the font preload on the flagged home shell", () => {
    const html = Layout({ title: "Fixture", theme: "home", inlineCriticalCss: true })!.toString();
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain('href="/fonts/mona-sans-latin-var.woff2" as="font"');
  });

  it("keeps the unflagged home shell on external stylesheets with the preload", () => {
    const html = Layout({ title: "Fixture", theme: "home" })!.toString();
    expect(html).toContain('rel="stylesheet" href="/styles.css"');
    expect(html).toContain('href="/fonts/mona-sans-latin-var.woff2" as="font"');
    expect(html).not.toContain("<style>");
  });

  it('serves "/" inlined under a hash-allowlisted CSP', async () => {
    const response = await pageShellFixture().request("/");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain('href="/fonts/mona-sans-latin-var.woff2" as="font"');
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
    expect(csp).not.toContain("unsafe-inline");
  });

  it("uses an Arimo-metric fallback ahead of system sans for delayed font swaps", () => {
    // The preload alone cannot close the cold-mobile FCP/font gap; the
    // size-adjusted fallback uses the measured average-advance ratio against
    // Arimo (Arial-metric-compatible) at wght 400 / wdth 100. Ascent/descent
    // overrides scale Mona Sans' hhea metrics by the same factor, so the
    // fallback hero paints close to the swapped-in text and the swap is not
    // a larger repaint that re-times LCP after FCP.
    expect(LEAF_CRITICAL_CSS).toContain("@font-face { font-family: 'Mona Sans Fallback'");
    expect(LEAF_CRITICAL_CSS).toContain("local('Liberation Sans'), local('Arimo'), local('Arial')");
    expect(LEAF_CRITICAL_CSS).toContain("size-adjust: 103.33%");
    expect(LEAF_CRITICAL_CSS).toContain("ascent-override: 105.49%");
    expect(LEAF_CRITICAL_CSS).toContain("descent-override: 30.97%");
    expect(LEAF_CRITICAL_CSS).toContain("line-gap-override: 0%");
    expect(LEAF_CRITICAL_CSS).toContain("Mona Sans, 'Mona Sans Fallback', system-ui, sans-serif");
    // Every Mona Sans stack carries the fallback: a stack without it would
    // swap to unadjusted system sans. (--font-display is the bare kit
    // literal, so match declarations, not the whole bundle.)
    const stacks =
      LEAF_CRITICAL_CSS.match(/(?:font-family|font)\s*:[^;{}]*Mona Sans,[^;{}]*;/g) ?? [];
    expect(stacks.length).toBeGreaterThanOrEqual(1);
    for (const stack of stacks) expect(stack).toContain("'Mona Sans Fallback'");
    const html = Layout({ title: "Fixture", theme: "home", inlineCriticalCss: true })!.toString();
    expect(html).toContain("'Mona Sans Fallback'");
  });

  it("emits the Mona Sans preload before the inlined style block", async () => {
    // Staging forensics: the font was discovered at document-end + ~25 ms in
    // every mobile sample (the preload sat after ~19 KB of inline CSS), so the
    // simulated font completion hovered at the paint boundary and flipped `/`
    // LCP between FCP and FCP + ~450 ms. Early discovery keeps LCP at FCP.
    const assertPreloadBeforeStyle = (html: string) => {
      const preload = html.indexOf('href="/fonts/mona-sans-latin-var.woff2" as="font"');
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
