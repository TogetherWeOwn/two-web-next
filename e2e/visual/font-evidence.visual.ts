import type { Page } from "@playwright/test";
import { expect, localOrigin, test } from "../fixtures";
import {
  captureWithGeometry,
  captureWithoutFontWait,
  loadVisualFont,
  readCaptureGeometry,
  renderedPlatformFonts,
} from "./font-evidence";

// Synthetic DOM only: no baselines or production font activation.
const FONT_URL = `${localOrigin}/fonts/mona-sans-latin-wght.woff2`;
async function fixturePage(page: Page) {
  await page.goto("/about");
  await page.setContent(`<body style="margin:0"><p id="probe" style="font:32px sans-serif">Together We Own</p>
    <p class="twin">a</p><p class="twin">b</p><div id="tall" style="height:3000px">tall</div></body>`);
}
for (const size of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test.describe(`font evidence @ ${size.width}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
      await fixturePage(page);
    });
    test("loads unique faces without style changes and inspects actual glyph usage", async ({
      page,
    }) => {
      const before = await page.content();
      const first = await loadVisualFont(page, { url: FONT_URL, weight: "100 900" });
      const second = await loadVisualFont(page, { url: FONT_URL });
      expect(first.family).toMatch(/^visual-font-[a-f0-9]+$/);
      expect(second.family).not.toBe(first.family);
      expect([first.status, second.status]).toEqual(["loaded", "loaded"]);
      expect([first.weight, second.weight]).toEqual(["100 900", "400"]);
      expect(await page.content()).toEqual(before);
      const fallback = await renderedPlatformFonts(page, "#probe");
      expect(fallback.length).toBeGreaterThan(0);
      expect(fallback.every((font) => !font.isCustomFont && font.glyphCount > 0)).toBe(true);
      await page.locator("#probe").evaluate((el, alias) => {
        (el as HTMLElement).style.fontFamily = alias;
      }, first.family);
      const used = await renderedPlatformFonts(page, "#probe");
      expect(used.some((font) => font.isCustomFont && font.glyphCount > 0)).toBe(true);
      expect(used.every((font) => font.isCustomFont)).toBe(true);
    });
    test("rejects ambiguous/missing nodes and failed font loads", async ({ page }) => {
      await expect(renderedPlatformFonts(page, "#absent")).rejects.toThrow(/exactly one.*found 0/);
      await expect(renderedPlatformFonts(page, ".twin")).rejects.toThrow(/exactly one.*found 2/);
      await expect(readCaptureGeometry(page, { gone: "#absent" })).rejects.toThrow(/found 0/);
      await expect(readCaptureGeometry(page, { twin: ".twin" })).rejects.toThrow(/found 2/);
      await expect(loadVisualFont(page, { url: `${FONT_URL}.absent` })).rejects.toThrow();
    });
    test("retains identical first/subsequent full-page captures and geometry", async ({ page }) => {
      const nodes = { probe: "#probe", tall: "#tall" };
      const first = await captureWithGeometry(page, nodes);
      const second = await captureWithGeometry(page, nodes);
      expect(first.dimensions.width).toBe(size.width);
      expect(first.dimensions.height).toBeGreaterThanOrEqual(3000);
      expect(first.before.viewport).toEqual(size);
      expect(first.after).toEqual(first.before);
      expect(first.before.nodes.tall?.height).toBe(3000);
      expect(second.before).toEqual(first.before);
      expect(second.after).toEqual(first.after);
      expect(second.dimensions).toEqual(first.dimensions);
      expect(second.png.equals(first.png)).toBe(true);
    });
    test("captures the viewport while document font readiness is pending", async ({ page }) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const held = page.waitForRequest((request) => request.url().includes("held=1"));
      await page.route("**/*held=1", async (route) => {
        await gate;
        await route.continue();
      });
      try {
        await page.addStyleTag({
          content: `@font-face { font-family: Held; src: url("${FONT_URL}?held=1");
          font-display: swap; } #probe { font-family: Held, sans-serif !important; }`,
        });
        await held;
        expect(await page.evaluate(() => document.fonts.status)).toBe("loading");
        const png = await captureWithoutFontWait(page);
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size.width, size.height]);
        expect(await page.evaluate(() => document.fonts.status)).toBe("loading");
      } finally {
        release();
      }
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.fonts.status)).toBe("loaded");
    });
  });
}
