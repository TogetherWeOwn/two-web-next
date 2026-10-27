// Existing browser-smoke discovers e2e/*.spec.ts. Hermetic SSR fixtures only.
// Local: NODE_OPTIONS=--import=tsx npx playwright test --config=e2e privacy-published-history.spec.ts --workers=1
// PRIVACY_HISTORY_SCREENSHOT_DIR saves the real before/after route states; open every image.
// Design contract: members/moderators inspect previous text without mistaking it
// for today's policy. Keep Open Lobby/Logo 1 chrome, semantic tokens, typography,
// current legal body and join/back navigation. Add a native h2/list after the
// current body with Version N links naming GitHub and historical-not-current
// status. Current version stays explicit. At 1280x800 / 390x844 links wrap inside
// the content column; native Tab/Enter works without JavaScript. No archive
// endpoint, old body bundles, client code, new tokens or quality-budget changes.
// References/assumptions: existing privacy twins and content-leaf navigation;
// no new visual direction. States: normal current page + keyboard-focused history.
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  compilePrivacyHistory,
  historyOrigin,
  historyRoot,
  renderPrivacyHistory,
  type HistoryTwin,
  type PrivacyHistoryFixture,
} from "../test/helpers/privacy-published-history";

let fixture: PrivacyHistoryFixture;
test.use({ javaScriptEnabled: false, serviceWorkers: "block" });
test.beforeAll(async () => {
  fixture = await compilePrivacyHistory();
});

async function openPrivacy(page: Page, twin: HistoryTwin) {
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== historyOrigin) {
      externalRequests.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/privacy") {
      const result = await renderPrivacyHistory(fixture, twin);
      expect(result.status).toBe(200);
      expect(result.touches).toEqual([]);
      // Content leaves already carry their real leafCss. Appending the general
      // theme again would overwrite content-specific typography and tokens.
      const css = twin === "Kit" ? fixture.css : "";
      expect(css).not.toContain("</style");
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: css ? result.html.replace("</head>", `<style>${css}</style></head>`) : result.html,
      });
    }
    const asset = resolve(historyRoot, "public", `.${url.pathname}`);
    if (!asset.startsWith(join(historyRoot, "public") + "/") || !existsSync(asset))
      return route.abort();
    return route.fulfill({ path: asset });
  });
  await page.goto(`${historyOrigin}/privacy`);
  return externalRequests;
}

async function capture(page: Page, twin: HistoryTwin, width: number, state: string) {
  const directory = process.env.PRIVACY_HISTORY_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${twin}-${width}-${state}.png`),
    animations: "disabled",
  });
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`${twin} ${viewport.width} PH-B01 native, named historical navigation works without JS`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await openPrivacy(page, twin);
      await capture(page, twin, viewport.width, "current");
      await expect(
        page.getByRole("heading", { level: 2, name: "Previous published versions", exact: true }),
      ).toHaveCount(1, { timeout: 1000 });
      const link = page.getByRole("link", { name: /Version\s+5.*(?:GitHub|public repository)/i });
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute(
        "href",
        /^https:\/\/github\.com\/TogetherWeOwn\/two-web-next\/blob\/[a-f0-9]{40}\/content\/privacy-policy-v5\.md$/,
      );
      const row = link.locator("xpath=ancestor::li");
      await expect(row).toHaveCount(1);
      await expect(page.locator('[data-testid="privacy-version"]')).toContainText(/current/i);
      for (let index = 0; index < 60; index += 1) {
        await page.keyboard.press("Tab");
        if (await link.evaluate((node) => node === node.ownerDocument.activeElement)) break;
      }
      await expect(link).toBeFocused();
      await capture(page, twin, viewport.width, "history-focused");
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      const target = await link.getAttribute("target");
      if (target === "_blank") await expect(link).toHaveAttribute("rel", /noopener/);
      // Observe navigation intent, never fetch the external public repository.
      const navigation = page
        .context()
        .waitForEvent("request", (request) =>
          request.url().includes("github.com/TogetherWeOwn/two-web-next/blob/"),
        );
      await page.keyboard.press("Enter");
      expect((await navigation).url()).toMatch(/\/content\/privacy-policy-v5\.md$/);
    });

    test(`${twin} ${viewport.width} PH-BC01 CONTROL real current policy fixture is accessible and has no script or overflow`, async ({
      browser,
    }) => {
      // Axe's audit frames require scripting. This separate context permits
      // audit injection only; PH-B01 above exercises native navigation with JS off.
      const context = await browser.newContext({
        javaScriptEnabled: true,
        viewport,
        serviceWorkers: "block",
      });
      try {
        const page = await context.newPage();
        await openPrivacy(page, twin);
        await expect(
          page.getByRole("heading", { level: 1, name: "Privacy policy", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Who we are, and what this covers", exact: true }),
        ).toBeVisible();
        await expect(page.locator('[data-testid="privacy-version"]')).toContainText("Version 6");
        await expect(page.locator("script")).toHaveCount(0);
        expect(await page.locator("html").evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        const results = await new AxeBuilder({ page }).analyze();
        expect(
          results.violations.filter(({ impact }) => impact === "critical" || impact === "serious"),
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}
