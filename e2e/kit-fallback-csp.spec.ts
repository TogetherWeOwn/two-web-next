// CSP-gated rendering proof for the catastrophic Kit fallback: the same
// substituted standalone document served WITH the exact production CSP must
// render the branded shell (the hash allowlist permits the inline style),
// while the unwidened policy documents the blocked presentation. The control
// pair is self-validating: if route.fulfill headers were ignored, both tests
// would see styled output and the control would fail.
// Self-contained mount (no Test Author helper import); standalone local HTML
// only: no Kit layout, stylesheets, DB, login or service.
// Run: NODE_OPTIONS=--import=tsx npx playwright test --config=e2e kit-fallback-csp.spec.ts --workers=1
// The normal browser-smoke *.spec.ts glob also runs these tests, without skips.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect as playwrightExpect, test, type Page } from "@playwright/test";
import { securityHeadersFor, withKitFallbackStyleCsp } from "../src/headers";

const expect = playwrightExpect.configure({ timeout: 1000 });
const origin = "http://localhost";
const fixtureUrl = `${origin}/__fallback-csp-fixture`;

const template = readFileSync(new URL("../web/src/error.html", import.meta.url), "utf8");
const substituteFallback = (status: number): string =>
  template.replace(/%sveltekit\.status%/g, () => String(status));

// The exact production policy for a decorated Kit response, optionally with
// the fallback allowlist the dispatch applies after reading the body.
const productionCsp = (widened: boolean): string => {
  const headers = securityHeadersFor({ path: "/events", method: "GET" });
  const found = headers.find(([name]) => name === "Content-Security-Policy");
  if (!found) throw new Error("CSP header missing");
  return widened ? withKitFallbackStyleCsp(found[1]) : found[1];
};

test.use({ javaScriptEnabled: false, serviceWorkers: "block" });

async function mount(page: Page, csp: string) {
  const dependencies: string[] = [];
  await page.context().setOffline(true);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const topDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
    if (topDocument && request.url() === fixtureUrl) {
      await route.fulfill({
        status: 500,
        contentType: "text/html; charset=utf-8",
        headers: { "Content-Security-Policy": csp },
        body: substituteFallback(500),
      });
    } else {
      dependencies.push(request.url());
      await route.abort();
    }
  });
  await page.goto(fixtureUrl, { waitUntil: "load" });
  return { dependencies };
}

test("widened production CSP renders the branded shell with no dependencies", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { dependencies } = await mount(page, productionCsp(true));
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(18, 23, 25)");
  await expect(page.locator("body")).toHaveCSS("color", "rgb(245, 245, 235)");
  expect(dependencies).toEqual([]);
});

test("unwidened production CSP blocks the inline style", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, productionCsp(false));
  await expect(page.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});
