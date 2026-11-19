import { expect, localOrigin, test } from "../fixtures";
import * as evidence from "./real-font-capture";

const { dataFont, displayFont } = evidence;
test("font hint classification follows HTML token rules", () => {
  const link = (space: string) => `<link rel="other${space}preload" as="FONT" href="${dataFont}">`;
  const hints = evidence.readHints(link("&nbsp;") + link("&#9;"));
  expect(hints.filter(evidence.isFontHint)).toEqual([
    { rel: "other\tpreload", as: "FONT", href: dataFont, priority: null },
  ]);
});

test("paint samples use timestamp order even when PNGs arrive out of order", () => {
  const frames = [170, 90, 110].map((ms) => ({ data: String(ms), timestamp: ms / 1000 }));
  const painted = evidence.paintedFrames(frames, { timeOrigin: 0, paintTime: 100 });
  expect(painted.map(({ atMs }) => atMs)).toEqual([110, 170]);
});

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
        const capture = await evidence.captureRealFont(page, path, state, testInfo, trackedFont);
        const { content, requests, settled, timing, warmup } = capture;
        expect(timing.viewport).toEqual({ width, height, devicePixelRatio: 1 });
        expect(settled.fonts.length).toBeGreaterThan(0);
        expect(settled.fonts.every((font) => !font.isCustomFont && font.glyphCount > 0)).toBe(true);
        const inventory = privacy ? [`${localOrigin}${dataFont}`] : [];
        expect(content.resources.map(({ name }) => name)).toEqual(inventory);
        const contentRequests = requests.filter(({ phase }) => phase === "content");
        const fontRequests = contentRequests.flatMap(({ type, url }) =>
          type === "Font" ? [url] : [],
        );
        expect(fontRequests).toEqual(inventory);
        const hints = [...content.rawHints, ...content.hints];
        expect(hints.filter(evidence.isFontHint)).toEqual([]);
        expect(content.headers.link).toBeUndefined();
        for (const { events } of contentRequests)
          expect(events.find(({ event }) => event === "early-hints")).toBeUndefined();
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
