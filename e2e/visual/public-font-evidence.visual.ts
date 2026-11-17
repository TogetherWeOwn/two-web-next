import { expect, localOrigin, test } from "../fixtures";
import {
  captureNormalizedDisplayFont,
  captureWithGeometry,
  renderedPlatformFonts,
} from "./font-evidence";

const FONT_URL = `${localOrigin}/fonts/mona-sans-latin-wght.woff2`;

for (const size of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  for (const [name, path, heading] of [
    ["about", "/about", "#about-heading"],
    ["rules", "/rules", "#rules-heading"],
  ]) {
    test(`${name} fallback font evidence @ ${size.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await page.route("**/fonts/mona-sans-latin-wght.woff2*", (route) => route.abort());
      const response = await page.goto(path!);
      expect(response?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      const fonts = await renderedPlatformFonts(page, heading!);
      const capture = await captureWithGeometry(
        page,
        { heading: heading! },
        {
          mask: [page.locator("time")],
          animations: "disabled",
          caret: "hide",
          scale: "css",
        },
      );
      await testInfo.attach(`${name}-fallback-${size.width}.png`, {
        body: capture.png,
        contentType: "image/png",
      });
      await testInfo.attach(`${name}-fallback-${size.width}.json`, {
        body: JSON.stringify({ fonts, ...capture, png: undefined }, null, 2),
        contentType: "application/json",
      });
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.every((font) => !font.isCustomFont && font.glyphCount > 0)).toBe(true);
    });
  }
}

test("normalized display font evidence on a fixture @ 360", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await page.route("**/visual-font-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<style>
        .content { --font-display: "Original, Display", Georgia, serif; min-height: 1200px; }
        h1 { font-family: var(--font-display); }
      </style><main class="content"><h1>Fixture heading</h1></main>`,
    }),
  );
  await page.goto("/visual-font-fixture");
  const capture = await captureNormalizedDisplayFont(page, {
    url: FONT_URL,
    weight: "100 900",
    root: ".content",
    heading: "h1",
  });
  await testInfo.attach("fixture-normalized-360.png", {
    body: capture.png,
    contentType: "image/png",
  });
  await testInfo.attach("fixture-normalized-360.json", {
    body: JSON.stringify({ ...capture, png: undefined }, null, 2),
    contentType: "application/json",
  });
  expect(capture.face.status).toBe("loaded");
  expect(capture.token.original).toBe('"Original, Display", Georgia, serif');
  expect(capture.token.normalized).toBe(`"${capture.face.family}", Georgia, serif`);
  expect(capture.fonts).toHaveLength(1);
  expect(capture.fonts[0]?.familyName).toMatch(/^Mona Sans(?:\s|$)/);
  expect(capture.fonts[0]?.isCustomFont).toBe(true);
  expect(capture.fonts[0]?.glyphCount).toBeGreaterThan(0);
  expect(capture.dimensions.width).toBe(360);
  expect(capture.dimensions.height).toBeGreaterThan(844);
  expect(capture.before.nodes.heading?.width).toBeGreaterThan(0);
  expect(capture.after.nodes.heading).toEqual(capture.before.nodes.heading);
});
