import { expect, localOrigin, test } from "../fixtures";
import { captureWithGeometry, readCaptureGeometry, renderedPlatformFonts } from "./font-evidence";

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
    const selectors = { code: evidenceSelector };
    const beforeIdle = await readCaptureGeometry(page, selectors);
    await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    });
    const afterIdle = await readCaptureGeometry(page, selectors);
    const idleFonts = await renderedPlatformFonts(page, evidenceSelector);
    expect(afterIdle).toEqual(beforeIdle);
    expect(idleFonts).toEqual(coldFonts);

    const settling = await captureWithGeometry(page, selectors);
    const settlingFonts = await renderedPlatformFonts(page, evidenceSelector);
    await testInfo.attach(`privacy-${size.width}-cold-settling.png`, {
      body: settling.png,
      contentType: "image/png",
    });
    await testInfo.attach(`privacy-${size.width}-cold-settling.json`, {
      body: JSON.stringify(
        {
          before: settling.before,
          after: settling.after,
          beforeFonts: idleFonts,
          afterFonts: settlingFonts,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(settling.before).toEqual(afterIdle);
    if (JSON.stringify(settling.before) !== JSON.stringify(settling.after)) {
      expect(settlingFonts.map((font) => font.familyName)).not.toEqual(
        idleFonts.map((font) => font.familyName),
      );
    }
    const first = await captureWithGeometry(page, selectors);
    await testInfo.attach(`privacy-${size.width}-cold-first.png`, {
      body: first.png,
      contentType: "image/png",
    });
    const second = await captureWithGeometry(page, selectors);
    await testInfo.attach(`privacy-${size.width}-cold-second.png`, {
      body: second.png,
      contentType: "image/png",
    });
    expect(settling.after).toEqual(first.before);
    expect(first.before).toEqual(first.after);
    expect(first.after).toEqual(second.before);
    expect(second.before).toEqual(second.after);
    expect(first.dimensions).toEqual(second.dimensions);
    expect(first.png.equals(second.png)).toBe(true);
  });

  test.describe(`warm data font at ${size.width}`, () => {
    test.use({ cachePreservingNetwork: true });
    test(`privacy inline code: warm data font at ${size.width}`, async ({
      page,
      context,
      browser,
    }, testInfo) => {
      const coldContext = await browser.newContext({
        baseURL: localOrigin,
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
        viewport: size,
      });
      let fallbackLineHeight: string;
      try {
        await coldContext.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (
            url.origin !== localOrigin ||
            url.pathname.endsWith("/fragment-mono-latin-400.woff2")
          ) {
            return route.abort("blockedbyclient");
          }
          return route.continue();
        });
        const coldPage = await coldContext.newPage();
        expect((await coldPage.goto(`${localOrigin}/privacy`))?.status()).toBe(200);
        await coldPage.evaluate(() => document.fonts.ready);
        const coldCode = coldPage.locator(codeSelector).first();
        await coldCode.evaluate((node) => node.setAttribute("data-font-evidence", ""));
        const coldFonts = await renderedPlatformFonts(coldPage, evidenceSelector);
        expect(
          coldFonts.some((font) => font.isCustomFont && font.familyName === "Fragment Mono"),
        ).toBe(false);
        expect(coldFonts.some((font) => font.glyphCount > 0)).toBe(true);
        fallbackLineHeight = await coldCode.evaluate(
          (node) => getComputedStyle(node.parentElement!).lineHeight,
        );
      } finally {
        await coldContext.close();
      }
      await page.setViewportSize(size);
      const primer = page;
      const warmPage = page;
      const warmSession = await context.newCDPSession(page);
      const fontPath = "/fonts/fragment-mono-latin-400.woff2";
      const primerHeaders: string[] = [];
      const returnRequests = new Set<string>();
      const cachedRequests = new Set<string>();
      const cachedResponses = new Set<string>();
      let returning = false;
      warmSession.on("Network.responseReceived", ({ response }) => {
        if (!returning && new URL(response.url).pathname === fontPath) {
          primerHeaders.push(
            String(response.headers["cache-control"] ?? response.headers["Cache-Control"] ?? ""),
          );
        }
      });
      warmSession.on("Network.requestWillBeSent", ({ requestId, request }) => {
        if (returning && new URL(request.url).pathname === fontPath) returnRequests.add(requestId);
      });
      warmSession.on("Network.requestServedFromCache", ({ requestId }) => {
        if (returning) cachedRequests.add(requestId);
      });
      warmSession.on("Network.responseReceived", ({ requestId, response }) => {
        if (returning && response.fromDiskCache) cachedResponses.add(requestId);
      });
      try {
        await warmSession.send("Network.enable");
        expect((await primer.goto(`${localOrigin}/privacy`))?.status()).toBe(200);
        await primer.evaluate(async () => {
          await document.fonts.load('14px "Fragment Mono"', "__Host-two_session");
        });
        // Navigate the primed page again so its renderer can reuse the loaded resource.
        returning = true;
        expect((await warmPage.goto(`${localOrigin}/privacy`))?.status()).toBe(200);
        await warmPage.evaluate(() => document.fonts.ready);
        const cacheEvidence = {
          primerHeaders,
          returnRequests: [...returnRequests],
          cachedRequests: [...cachedRequests],
          cachedResponses: [...cachedResponses],
          reuseObserved: [...returnRequests].some(
            (id) => cachedRequests.has(id) || cachedResponses.has(id),
          ),
        };
        await testInfo.attach(`privacy-${size.width}-font-cache.json`, {
          body: JSON.stringify(cacheEvidence, null, 2),
          contentType: "application/json",
        });
        expect(primerHeaders).toContain("public, max-age=31536000, immutable");
        expect(cacheEvidence.reuseObserved).toBe(true);
        const warmCode = warmPage.locator(codeSelector).first();
        await warmCode.evaluate((node) => node.setAttribute("data-font-evidence", ""));
        const warmFonts = await renderedPlatformFonts(warmPage, evidenceSelector);
        await testInfo.attach(`privacy-${size.width}-warm-fonts.json`, {
          body: JSON.stringify(warmFonts, null, 2),
          contentType: "application/json",
        });
        expect(
          warmFonts.some(
            (font) =>
              font.isCustomFont && font.familyName === "Fragment Mono" && font.glyphCount > 0,
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
        await warmSession.detach();
      }
    });
  });
}
