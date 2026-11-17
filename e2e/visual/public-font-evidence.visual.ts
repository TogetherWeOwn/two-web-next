import { expect, localOrigin, test } from "../fixtures";
import { captureWithGeometry, loadVisualFont, renderedPlatformFonts } from "./font-evidence";

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

test("rules separately loaded Mona Sans evidence @ 360", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 844 });
  const response = await page.goto("/rules");
  expect(response?.status()).toBe(200);
  await page.waitForLoadState("networkidle");
  const face = await loadVisualFont(page, { url: FONT_URL, weight: "100 900" });
  await page.locator("#rules-heading").evaluate((el, family) => {
    (el as HTMLElement).style.fontFamily = family;
  }, face.family);
  const fonts = await renderedPlatformFonts(page, "#rules-heading");
  const capture = await captureWithGeometry(
    page,
    { heading: "#rules-heading" },
    {
      mask: [page.locator("time")],
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  );
  await testInfo.attach("rules-mona-sans-360.png", { body: capture.png, contentType: "image/png" });
  await testInfo.attach("rules-mona-sans-360.json", {
    body: JSON.stringify({ face, fonts, ...capture, png: undefined }, null, 2),
    contentType: "application/json",
  });
  expect(face.status).toBe("loaded");
  expect(fonts).toHaveLength(1);
  expect(fonts[0]?.familyName).toMatch(/^Mona Sans(?:\s|$)/);
  expect(fonts[0]?.isCustomFont).toBe(true);
  expect(fonts[0]?.glyphCount).toBeGreaterThan(0);
});
