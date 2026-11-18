import { expect, localOrigin, test } from "../fixtures";
import {
  captureNormalizedDisplayFont,
  captureWithGeometry,
  expectStablePublicPageCapture,
  loadVisualFont,
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

test("rules full-page display evidence @ 360", async ({ page }, testInfo) => {
  const size = { width: 360, height: 844 };
  const heading = "#rules-heading";
  await page.setViewportSize(size);
  expect((await page.goto("/rules"))?.status()).toBe(200);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  const capture = await expectStablePublicPageCapture(page, testInfo, {
    heading,
    width: size.width,
  });
  expect(capture.dimensions.height).toBeGreaterThan(size.height);
  const fonts = await renderedPlatformFonts(page, heading);
  await testInfo.attach("rules-360-fonts", {
    body: JSON.stringify(fonts),
    contentType: "application/json",
  });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((font) => !font.isCustomFont && font.glyphCount > 0)).toBe(true);
});

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

for (const [description, stack, fallback] of [
  ["unquoted family", "Original Display, Georgia, serif", ", Georgia, serif"],
  ["single-quoted family", "'Original, Display', serif", ", serif"],
  ["no fallback", "Original Display", ""],
  ["escaped quote", '"Original\\" Display", Georgia, serif', ", Georgia, serif"],
  ["space after quoted family", '"Original, Display" , Georgia, serif', ", Georgia, serif"],
  ["escaped comma", "Original\\,Display, serif", ", serif"],
  ["multiline fallback", "Original Display,\nGeorgia, serif", ",\nGeorgia, serif"],
  ["non-CSS whitespace in fallback", "Original Display, Georgia ", ", Georgia "],
  ["comma in a comment", "Original /* , */ Display, Georgia, serif", ", Georgia, serif"],
  ["escaped final space", "Original Display, /* keep */ Backup\\ ", ", /* keep */ Backup\\ "],
]) {
  test(`normalizes a display stack with ${description}`, async ({ page }) => {
    await page.goto("/rules");
    await page.locator("#rules-heading").evaluate((element, value) => {
      (element as HTMLElement).style.setProperty("--font-display", value!);
    }, stack);
    const capture = await captureNormalizedDisplayFont(page, {
      url: FONT_URL,
      root: "#rules-heading",
      heading: "#rules-heading",
    });
    expect(capture.token.original).toBe(stack);
    expect(capture.token.normalized).toBe(`"${capture.face.family}"${fallback}`);
  });
}

for (const [description, value] of [
  ["missing", null],
  ["empty", "   "],
] as const) {
  test(`rejects a ${description} display token`, async ({ page }) => {
    await page.route("**/empty-font-fixture", (route) =>
      route.fulfill({ contentType: "text/html", body: "<main><h1>Fixture</h1></main>" }),
    );
    await page.goto("/empty-font-fixture");
    if (value !== null) {
      await page.locator("main").evaluate((element, token) => {
        (element as HTMLElement).style.setProperty("--font-display", token);
      }, value);
    }
    await expect(
      captureNormalizedDisplayFont(page, {
        url: FONT_URL,
        root: "main",
        heading: "h1",
      }),
    ).rejects.toThrow("Expected a nonempty --font-display stack");
  });
}

test("rejects a display token override blocked by an important declaration", async ({ page }) => {
  await page.route("**/important-font-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<style>main { --font-display: Original, serif !important; }</style><main><h1>Fixture</h1></main>",
    }),
  );
  await page.goto("/important-font-fixture");
  await expect(
    captureNormalizedDisplayFont(page, { url: FONT_URL, root: "main", heading: "h1" }),
  ).rejects.toThrow("Display token override did not take effect");
});

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
  expect(capture.headingFamily.split(",")[0]?.replaceAll('"', "").trim()).toBe(capture.face.family);
  expect(capture.fonts).toHaveLength(1);
  expect(capture.fonts[0]?.familyName).toMatch(/^Mona Sans(?:\s|$)/);
  expect(capture.fonts[0]?.isCustomFont).toBe(true);
  expect(capture.fonts[0]?.glyphCount).toBeGreaterThan(0);
  expect(capture.dimensions.width).toBe(360);
  expect(capture.dimensions.height).toBeGreaterThan(844);
  expect(capture.before.nodes.heading?.width).toBeGreaterThan(0);
  expect(capture.after.nodes.heading).toEqual(capture.before.nodes.heading);
});
