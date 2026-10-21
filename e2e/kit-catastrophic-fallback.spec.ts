// Standalone local HTML only: no Kit layout, stylesheets, DB, login or service.
// Run: NODE_OPTIONS=--import=tsx npx playwright test --config=e2e kit-catastrophic-fallback.spec.ts --workers=1
// The normal browser-smoke *.spec.ts glob also runs these tests, without skips.
// Set FALLBACK_SCREENSHOT_DIR to capture desktop/mobile/forced-colors evidence.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect as playwrightExpect, test, type Page } from "@playwright/test";
import {
  privateFailureMessages,
  renderCatastrophicFallback,
} from "../test/helpers/kit-catastrophic-fallback";

// The complete static document is present at load; there is no async UI to await.
const expect = playwrightExpect.configure({ timeout: 1000 });
const origin = "http://localhost";
const fixtureUrl = `${origin}/__catastrophic-fixture`;
const presentations = [
  { name: "desktop", width: 1280, height: 800, forcedColors: "none" },
  { name: "mobile", width: 390, height: 844, forcedColors: "none" },
  { name: "forced-colors", width: 390, height: 844, forcedColors: "active" },
] as const;
const recoveryLinks = [
  { name: /\bhome\b/i, href: "/" },
  { name: /\bevents\b/i, href: "/events" },
] as const;

test.use({ javaScriptEnabled: false, serviceWorkers: "block" });

async function mount(page: Page, status = 500, message = privateFailureMessages[0]!) {
  const dependencies: string[] = [];
  const destinations: string[] = [];
  await page.context().setOffline(true);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const topDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
    if (topDocument && request.url() === fixtureUrl) {
      await route.fulfill({
        status,
        contentType: "text/html; charset=utf-8",
        body: renderCatastrophicFallback(status, message),
      });
    } else if (
      topDocument &&
      request.method() === "GET" &&
      recoveryLinks.some((link) => request.url() === `${origin}${link.href}`)
    ) {
      // Proves native link navigation intent, not availability of a live route.
      destinations.push(request.url());
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Local recovery destination</title>",
      });
    } else {
      dependencies.push(request.url());
      await route.abort();
    }
  });
  await page.goto(fixtureUrl, { waitUntil: "load" });
  return { dependencies, destinations };
}

async function capture(page: Page, name: string) {
  if (!process.env.FALLBACK_SCREENSHOT_DIR) return;
  mkdirSync(process.env.FALLBACK_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: join(process.env.FALLBACK_SCREENSHOT_DIR, `${name}.png`),
    animations: "disabled",
  });
}

for (const presentation of presentations) {
  test.describe(presentation.name, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: presentation.width, height: presentation.height });
      await page.emulateMedia({ forcedColors: presentation.forcedColors });
    });

    test("identifies the site and failure with accessible standalone document semantics", async ({
      page,
    }) => {
      await mount(page);
      await capture(page, presentation.name);
      const metadata = await page.evaluate<{
        viewport: string | null | undefined;
        robots: string | null | undefined;
        language: string;
      }>(`({
        viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content"),
        robots: document.querySelector('meta[name="robots"]')?.getAttribute("content"),
        language: document.documentElement.lang,
      })`);
      expect.soft(metadata.language).toBe("en");
      expect.soft(metadata.viewport).toMatch(/width\s*=\s*device-width/i);
      expect.soft(metadata.viewport).toMatch(/initial-scale\s*=\s*1(?:\D|$)/i);
      expect.soft(metadata.robots?.split(/[\s,]+/)).toContain("noindex");
      await expect.soft(page).toHaveTitle(/Together We Own/i);
      await expect.soft(page).toHaveTitle(/error|unavailable|wrong|problem|recover|fail/i);
      await expect.soft(page.getByRole("main")).toHaveCount(1);
      await expect.soft(page.locator("h1")).toHaveCount(1);
      await expect.soft(page.getByRole("heading", { level: 1 })).toContainText("500");
      await expect.soft(page.getByText("Together We Own", { exact: false }).first()).toBeVisible();
      const explanation = page.locator("main p").filter({
        hasText:
          /try.*(?:again|later)|unavailable|went wrong|unable|could not|couldn't|cannot|can't|fail|problem|trouble/i,
      });
      await expect.soft(explanation.first()).toBeVisible();
    });

    test("is readable without overflow, scripts or fetched presentation", async ({ page }) => {
      const { dependencies } = await mount(page);
      await expect
        .soft(page.locator("script, link[rel~='stylesheet'], iframe, object, embed"))
        .toHaveCount(0);
      expect.soft(dependencies, "no stylesheet, font, image or API request is needed").toEqual([]);
      const dimensions = await page.evaluate<{ width: number; scrollWidth: number }>(`({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })`);
      expect.soft(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
      for (const locator of [
        page.locator("h1"),
        ...recoveryLinks.map((link) => page.getByRole("link", { name: link.name })),
      ]) {
        await expect.soft(locator).toBeVisible();
        if ((await locator.count()) !== 1) continue;
        const box = await locator.boundingBox();
        expect.soft(box).not.toBeNull();
        if (box) {
          expect.soft(box.x).toBeGreaterThanOrEqual(0);
          expect.soft(box.x + box.width).toBeLessThanOrEqual(presentation.width);
        }
      }
      const copy = await page.locator("main p, main a").evaluateAll((elements) =>
        elements.map((element) => {
          const style = element.ownerDocument.defaultView!.getComputedStyle(element);
          return {
            size: Number.parseFloat(style.fontSize),
            color: style.color,
            hidden:
              style.visibility !== "visible" || style.display === "none" || style.opacity === "0",
            forcedColors: style.forcedColorAdjust,
          };
        }),
      );
      expect.soft(copy.length).toBeGreaterThanOrEqual(3);
      for (const item of copy) {
        expect.soft(item.size).toBeGreaterThanOrEqual(16);
        expect.soft(item.hidden).toBe(false);
        expect.soft(item.color).not.toBe("rgba(0, 0, 0, 0)");
        if (presentation.forcedColors === "active") expect.soft(item.forcedColors).not.toBe("none");
      }
    });

    for (const link of recoveryLinks) {
      test(`${link.href}: keyboard recovery works offline without JavaScript`, async ({ page }) => {
        const { dependencies, destinations } = await mount(page);
        const anchor = page.getByRole("link", { name: link.name });
        await expect(anchor).toHaveCount(1);
        await expect(anchor).toHaveAttribute("href", link.href);
        await expect(anchor).not.toHaveAttribute("target", "_blank");
        for (let index = 0; index < 8; index++) {
          await page.keyboard.press("Tab");
          if (await anchor.evaluate((element) => element === element.ownerDocument.activeElement))
            break;
        }
        await expect(anchor).toBeFocused();
        const focus = await anchor.evaluate((element) => {
          const style = element.ownerDocument.defaultView!.getComputedStyle(element);
          return {
            visible: element.matches(":focus-visible"),
            outline: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 1,
            shadow: style.boxShadow !== "none",
          };
        });
        expect(focus.visible).toBe(true);
        expect(focus.outline || focus.shadow, "focus must be visually discernible").toBe(true);
        await capture(page, `${presentation.name}-focus-${link.href === "/" ? "home" : "events"}`);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(`${origin}${link.href}`);
        expect(destinations).toEqual([`${origin}${link.href}`]);
        expect(dependencies).toEqual([]);
      });
    }
  });
}

test.describe("untrusted exception details", () => {
  test.use({ javaScriptEnabled: true });
  for (const [index, message] of privateFailureMessages.entries()) {
    test(`message ${index + 1}: no private text, markup injection or resource fetch`, async ({
      page,
    }) => {
      const { dependencies } = await mount(page, 503, message);
      await expect.soft(page.getByRole("heading", { level: 1 })).toContainText("503");
      expect.soft(await page.content()).not.toContain("TEST_ONLY_PRIVATE_DETAIL");
      expect.soft(await page.content()).not.toContain("leak.invalid");
      expect.soft(await page.evaluate("globalThis.fallbackInjected === true")).toBe(false);
      await expect.soft(page.locator("script, [onerror], [onload]")).toHaveCount(0);
      expect.soft(dependencies).toEqual([]);
    });
  }

  test("standalone normal-color document meets WCAG AA without app CSS", async ({ page }) => {
    await mount(page);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
