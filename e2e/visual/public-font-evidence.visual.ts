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
  const token = await page.locator(".base-theme.content-theme").evaluate((el, family) => {
    const root = el as HTMLElement;
    const fallback = getComputedStyle(root).getPropertyValue("--font-display").trim();
    root.style.setProperty("--font-display", `"${family}", ${fallback}`);
    return {
      fallback,
      normalized: getComputedStyle(root).getPropertyValue("--font-display").trim(),
    };
  }, face.family);
  // Main still guards these content rules; mirror the successor only for this capture.
  await page.addStyleTag({
    content: `.base-theme.content-theme { font-family: var(--font-ui); }
      .base-theme.content-theme .main-nav a, .base-theme.content-theme .header-account,
      .base-theme.content-theme .btn, .base-theme.content-theme :is(h1, h2, h3) {
        font-family: var(--font-display);
      }`,
  });
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
    body: JSON.stringify({ face, token, fonts, ...capture, png: undefined }, null, 2),
    contentType: "application/json",
  });
  expect(face.status).toBe("loaded");
  expect(token.fallback).not.toBe("");
  expect(token.normalized).toBe(`"${face.family}", ${token.fallback}`);
  expect(fonts).toHaveLength(1);
  expect(fonts[0]?.familyName).toMatch(/^Mona Sans(?:\s|$)/);
  expect(fonts[0]?.isCustomFont).toBe(true);
  expect(fonts[0]?.glyphCount).toBeGreaterThan(0);
});
