import { expect, localOrigin, test } from "../fixtures";
import { captureWithGeometry, renderedPlatformFonts } from "./font-evidence";

const codeSelector = ".base-theme.content-theme code";
const evidenceSelector = `${codeSelector}:first-of-type[data-font-evidence]`;
const fontUrl = "**/fonts/fragment-mono-latin-400.woff2";

for (const size of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`privacy inline code: blocked fallback at ${size.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    await page.route(fontUrl, (route) => route.abort());
    expect((await page.goto(`${localOrigin}/privacy`))?.status()).toBe(200);
    const code = page.locator(codeSelector).first();
    await expect(code).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const fallback = await code.evaluate((node) => {
      const style = getComputedStyle(node);
      const parent = node.parentElement!;
      return {
        fontFamily: style.fontFamily,
        fontSize: parseFloat(style.fontSize),
        parentSize: parseFloat(getComputedStyle(parent).fontSize),
        overflowWrap: style.overflowWrap,
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    expect(fallback.fontFamily).toContain("Fragment Mono");
    expect(fallback.fontSize).toBeCloseTo(fallback.parentSize * 0.875, 2);
    expect(fallback.overflowWrap).toBe("anywhere");
    expect(fallback.pageWidth).toBeLessThanOrEqual(size.width);
    // Mark the actual first code element uniquely for CDP.
    await code.evaluate((node) => node.setAttribute("data-font-evidence", ""));
    const coldFonts = await renderedPlatformFonts(page, evidenceSelector);
    expect(coldFonts.some((font) => font.isCustomFont && font.familyName === "Fragment Mono")).toBe(
      false,
    );
    expect(coldFonts.some((font) => font.glyphCount > 0)).toBe(true);
    const first = await captureWithGeometry(page, { code: evidenceSelector });
    await testInfo.attach(`privacy-${size.width}-cold-first.png`, {
      body: first.png,
      contentType: "image/png",
    });
    const second = await captureWithGeometry(page, { code: evidenceSelector });
    await testInfo.attach(`privacy-${size.width}-cold-second.png`, {
      body: second.png,
      contentType: "image/png",
    });
    expect(first.before).toEqual(first.after);
    expect(first.after).toEqual(second.before);
    expect(second.before).toEqual(second.after);
    expect(first.png.equals(second.png)).toBe(true);
  });

  test(`privacy inline code: warm data font at ${size.width}`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize(size);
    await page.route(fontUrl, (route) => route.abort());
    expect((await page.goto(`${localOrigin}/privacy`))?.status()).toBe(200);
    const fallbackLineHeight = await page
      .locator(codeSelector)
      .first()
      .evaluate((node) => getComputedStyle(node.parentElement!).lineHeight);
    await page.unroute(fontUrl);
    const primer = await context.newPage();
    const warmPage = await context.newPage();
    const primerSession = await context.newCDPSession(primer);
    const warmSession = await context.newCDPSession(warmPage);
    const fontPath = "/fonts/fragment-mono-latin-400.woff2";
    const primerHeaders: string[] = [];
    const returnRequests = new Set<string>();
    const cachedRequests = new Set<string>();
    const cachedResponses = new Set<string>();
    primerSession.on("Network.responseReceived", ({ response }) => {
      if (new URL(response.url).pathname === fontPath) {
        primerHeaders.push(
          String(response.headers["cache-control"] ?? response.headers["Cache-Control"] ?? ""),
        );
      }
    });
    warmSession.on("Network.requestWillBeSent", ({ requestId, request }) => {
      if (new URL(request.url).pathname === fontPath) returnRequests.add(requestId);
    });
    warmSession.on("Network.requestServedFromCache", ({ requestId }) =>
      cachedRequests.add(requestId),
    );
    warmSession.on("Network.responseReceived", ({ requestId, response }) => {
      if (response.fromDiskCache) cachedResponses.add(requestId);
    });
    try {
      await primerSession.send("Network.enable");
      await warmSession.send("Network.enable");
      await primerSession.send("Network.setCacheDisabled", { cacheDisabled: false });
      await warmSession.send("Network.setCacheDisabled", { cacheDisabled: false });
      await primer.setViewportSize(size);
      expect((await primer.goto(`${localOrigin}/privacy`))?.status()).toBe(200);
      await primer.evaluate(async () => {
        await document.fonts.load('14px "Fragment Mono"', "__Host-two_session");
      });
      await warmPage.setViewportSize(size);
      expect((await warmPage.goto(`${localOrigin}/privacy`))?.status()).toBe(200);
      await warmPage.evaluate(() => document.fonts.ready);
      const cacheEvidence = {
        primerHeaders,
        returnRequests: [...returnRequests],
        cachedRequests: [...cachedRequests],
        cachedResponses: [...cachedResponses],
      };
      await testInfo.attach(`privacy-${size.width}-font-cache.json`, {
        body: JSON.stringify(cacheEvidence, null, 2),
        contentType: "application/json",
      });
      expect(primerHeaders).toContain("public, max-age=31536000, immutable");
      expect(
        [...returnRequests].some((id) => cachedRequests.has(id) || cachedResponses.has(id)),
        "Return navigation must reuse the exact font from Chromium's cache",
      ).toBe(true);
      const warmCode = warmPage.locator(codeSelector).first();
      await warmCode.evaluate((node) => node.setAttribute("data-font-evidence", ""));
      const warmFonts = await renderedPlatformFonts(warmPage, evidenceSelector);
      expect(
        warmFonts.some(
          (font) => font.isCustomFont && font.familyName === "Fragment Mono" && font.glyphCount > 0,
        ),
      ).toBe(true);
      expect(
        await warmCode.evaluate((node) => getComputedStyle(node.parentElement!).lineHeight),
      ).toBe(fallbackLineHeight);
      const first = await captureWithGeometry(warmPage, { code: evidenceSelector });
      await testInfo.attach(`privacy-${size.width}-warm-first.png`, {
        body: first.png,
        contentType: "image/png",
      });
      const second = await captureWithGeometry(warmPage, { code: evidenceSelector });
      await testInfo.attach(`privacy-${size.width}-warm-second.png`, {
        body: second.png,
        contentType: "image/png",
      });
      expect(first.before).toEqual(first.after);
      expect(first.after).toEqual(second.before);
      expect(second.before).toEqual(second.after);
      expect(first.dimensions).toEqual(second.dimensions);
      expect(first.png.equals(second.png)).toBe(true);
    } finally {
      await primerSession.detach();
      await warmSession.detach();
      await primer.close();
      await warmPage.close();
    }
  });
}
