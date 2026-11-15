import { expect, localOrigin, test } from "../fixtures";
import { captureWithGeometry, renderedPlatformFonts } from "./font-evidence";

const codeSelector = ".base-theme.content-theme code";
const fontUrl = "**/fonts/fragment-mono-latin-400.woff2";

for (const size of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`privacy inline code: blocked fallback and warm data font at ${size.width}`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize(size);
    await page.route(fontUrl, (route) => route.abort());
    expect((await page.goto(`${localOrigin}/privacy`))?.status()).toBe(200);
    const code = page.locator(codeSelector).first();
    await expect(code).toBeVisible();
    const fallback = await code.evaluate((node) => {
      const style = getComputedStyle(node);
      const parent = node.parentElement!;
      return {
        fontFamily: style.fontFamily,
        fontSize: parseFloat(style.fontSize),
        parentSize: parseFloat(getComputedStyle(parent).fontSize),
        lineHeight: getComputedStyle(parent).lineHeight,
        overflowWrap: style.overflowWrap,
        pageWidth: document.documentElement.scrollWidth,
      };
    });
    expect(fallback.fontFamily).toContain("Fragment Mono");
    expect(fallback.fontSize).toBeCloseTo(fallback.parentSize * 0.875, 2);
    expect(fallback.overflowWrap).toBe("anywhere");
    expect(fallback.pageWidth).toBeLessThanOrEqual(size.width);
    const selector = `${codeSelector}:first-of-type`;
    // The actual first code element is unique for CDP, even if other paragraphs contain code.
    await code.evaluate((node) => node.setAttribute("data-font-evidence", ""));
    const evidenceSelector = `${selector}[data-font-evidence]`;
    const coldFonts = await renderedPlatformFonts(page, evidenceSelector);
    expect(coldFonts.some((font) => font.isCustomFont && font.familyName === "Fragment Mono")).toBe(
      false,
    );
    expect(coldFonts.some((font) => font.glyphCount > 0)).toBe(true);
    const coldFirst = await captureWithGeometry(page, { code: evidenceSelector });
    const coldSecond = await captureWithGeometry(page, { code: evidenceSelector });
    await testInfo.attach(`privacy-${size.width}-cold-first.png`, {
      body: coldFirst.png,
      contentType: "image/png",
    });
    await testInfo.attach(`privacy-${size.width}-cold-second.png`, {
      body: coldSecond.png,
      contentType: "image/png",
    });
    expect(coldFirst.before).toEqual(coldFirst.after);
    expect(coldFirst.after).toEqual(coldSecond.before);
    expect(coldSecond.before).toEqual(coldSecond.after);
    expect(coldFirst.png.equals(coldSecond.png)).toBe(true);

    await page.unroute(fontUrl);
    const warmPage = await context.newPage();
    await warmPage.setViewportSize(size);
    expect((await warmPage.goto(`${localOrigin}/privacy`))?.status()).toBe(200);
    await warmPage.evaluate(async () => {
      await document.fonts.load('14px "Fragment Mono"', "__Host-two_session");
    });
    expect((await warmPage.reload())?.status()).toBe(200);
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
    ).toBe(fallback.lineHeight);
    const first = await captureWithGeometry(warmPage, { code: evidenceSelector });
    const second = await captureWithGeometry(warmPage, { code: evidenceSelector });
    await testInfo.attach(`privacy-${size.width}-warm-first.png`, {
      body: first.png,
      contentType: "image/png",
    });
    await testInfo.attach(`privacy-${size.width}-warm-second.png`, {
      body: second.png,
      contentType: "image/png",
    });
    expect(first.before).toEqual(first.after);
    expect(first.after).toEqual(second.before);
    expect(second.before).toEqual(second.after);
    expect(first.dimensions).toEqual(second.dimensions);
    expect(first.png.equals(second.png)).toBe(true);
    await warmPage.close();
  });
}
