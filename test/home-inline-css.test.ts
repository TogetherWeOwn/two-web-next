import { describe, expect, it } from "vitest";
import { LEAF_CRITICAL_CSS, LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import { Layout } from "../src/pages";
import { pageShellFixture } from "./helpers/page-shells";

// Homepage paint path: "/" reuses the leaf critical-CSS bundle inline and
// drops the Display-700 preload, so first paint needs zero render-blocking
// requests. Recovery/error shells keep theme="home" without the flag and must
// stay on external stylesheets (narrow scope: only "/" carries the hash).
describe("homepage inlined critical CSS", () => {
  it("inlines the leaf bundle with no render-blocking requests on the flagged home shell", () => {
    const html = Layout({ title: "Fixture", theme: "home", inlineCriticalCss: true })!.toString();
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toContain('.woff2" as="font"');
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
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toContain('.woff2" as="font"');
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
    expect(csp).not.toContain("unsafe-inline");
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
