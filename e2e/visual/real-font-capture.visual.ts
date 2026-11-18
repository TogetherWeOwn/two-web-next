import { expect, localOrigin, test } from "../fixtures";
import { captureRealFont, dataFont, displayFont } from "./real-font-capture";

// Intercepting any request in the context disables Chromium's HTTP cache.
test.use({
  cachePreservingNetwork: true,
  colorScheme: "dark",
  deviceScaleFactor: 1,
  locale: "en-US",
  timezoneId: "UTC",
});

for (const path of ["/about", "/faq", "/rules", "/privacy"]) {
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    for (const state of ["cold", "warm", "cold-shaped"] as const) {
      test(`real font evidence: ${path} @ ${width} ${state}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height });
        const privacy = path === "/privacy";
        const trackedFont = privacy ? dataFont : displayFont;
        const capture = await captureRealFont(page, path, state, testInfo, trackedFont);
        const { content, requests, settled, timing, warmup } = capture;
        expect(timing.viewport).toEqual({ width, height, devicePixelRatio: 1 });
        expect(settled.fonts.length).toBeGreaterThan(0);
        expect(settled.fonts.every((font) => !font.isCustomFont && font.glyphCount > 0)).toBe(true);
        const inventory = privacy ? [`${localOrigin}${dataFont}`] : [];
        expect(content.resources.map(({ name }) => name)).toEqual(inventory);
        const contentRequests = requests.filter(({ phase }) => phase === "content");
        expect(contentRequests.filter(({ type }) => type === "Font").map(({ url }) => url)).toEqual(
          inventory,
        );
        expect(
          [...content.rawHints, ...content.hints].filter(
            ({ as, href }) => as === "font" || href?.includes(displayFont),
          ),
        ).toEqual([]);
        expect(content.headers.link).toBeUndefined();
        expect(
          contentRequests.flatMap(({ events }) => events).map(({ event }) => event),
        ).not.toContain("early-hints");
        if (state === "warm") {
          const preload = expect.objectContaining({
            rel: "preload",
            as: "font",
            href: displayFont,
          });
          expect(warmup?.rawHints).toContainEqual(preload);
          expect(warmup?.hints).toContainEqual(preload);
          const homeFont = warmup?.resources.find(
            ({ name }) => name === `${localOrigin}${displayFont}`,
          );
          expect(homeFont?.initiatorType).toBe("link");
          expect(homeFont?.transferSize).toBeGreaterThan(0);
          const homeRequest = requests.find(
            ({ phase, url }) => phase === "homepage" && url === homeFont?.name,
          );
          expect(homeRequest?.detail).toMatchObject({ isLinkPreload: true });
        }
        if (privacy && state === "cold-shaped") {
          expect(capture.firstFrameAtMs).toBeLessThan(capture.resourceEnd!);
          expect(capture.afterFontAtMs).toBeGreaterThan(capture.resourceEnd!);
        }
      });
    }
  }
}
