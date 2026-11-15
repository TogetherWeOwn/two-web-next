import { expect, test } from "../fixtures";
import {
  captureWithGeometry,
  loadVisualFont,
  readCaptureGeometry,
  renderedPlatformFonts,
} from "./font-evidence";

const nodes = { heading: ".content-theme h1", main: "main", footer: "footer" };

for (const [viewport, size] of [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  for (const arm of ["metrics", "native"] as const) {
    test(`privacy diagnostic ${arm} @ ${viewport}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      expect((await page.goto("/privacy"))?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      const font = await loadVisualFont(page, {
        url: "/fonts/mona-sans-latin-wght.woff2",
        weight: "200 900",
      });
      expect(font.status).toBe("loaded");
      await page.evaluate((family) => {
        const root = document.querySelector<HTMLElement>(".content-theme")!;
        const stack = getComputedStyle(root).getPropertyValue("--font-display");
        if (!/^\s*['"]?Mona Sans Content['"]?\s*,/.test(stack))
          throw new Error("Unexpected content display font stack");
        root.style.setProperty(
          "--font-display",
          stack.replace(/^\s*['"]?Mona Sans Content['"]?\s*,/, `"${family}",`),
        );
      }, font.family);
      await page.evaluate(() => document.fonts.ready);
      const fonts = await renderedPlatformFonts(page, nodes.heading);
      expect(fonts.length).toBeGreaterThan(0);
      expect(
        fonts.every(
          (font) =>
            font.isCustomFont &&
            font.glyphCount > 0 &&
            font.postScriptName === "MonaSansExtraLight-Regular",
        ),
      ).toBe(true);

      const ledger = () =>
        page.evaluate(() =>
          Array.from(
            document.querySelectorAll(
              "main, main > *, main section, main h1, main h2, main h3, main h4, main p, main ul, main ol, main li, main table, main .cta, footer",
            ),
          ).map((el, index) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              index,
              tag: el.tagName,
              id: el.id,
              className: el.className,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              font: style.font,
              lineHeight: style.lineHeight,
              margin: style.margin,
              padding: style.padding,
              position: style.position,
              contain: style.contain,
              contentVisibility: style.contentVisibility,
              animation: style.animation,
            };
          }),
        );
      const session = await page.context().newCDPSession(page);
      try {
        const before = await readCaptureGeometry(page, nodes);
        const beforeLedger = await ledger();
        const metrics = await session.send("Page.getLayoutMetrics");
        const afterMetrics = await readCaptureGeometry(page, nodes);
        const metricsLedger = await ledger();
        let png: Buffer;
        let capture: unknown;
        if (arm === "metrics") {
          const result = await captureWithGeometry(page, nodes, {
            animations: "disabled",
            caret: "hide",
            scale: "css",
          });
          png = result.png;
          capture = { before: result.before, after: result.after, dimensions: result.dimensions };
        } else {
          const result = await session.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y: 0,
              width: before.document.scrollWidth,
              height: before.document.scrollHeight,
              scale: 1,
            },
          });
          png = Buffer.from(result.data, "base64");
          capture = {
            dimensions: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
            after: await readCaptureGeometry(page, nodes),
          };
        }
        await testInfo.attach("diagnostic-first-png", { body: png, contentType: "image/png" });
        await testInfo.attach("diagnostic-ledger", {
          body: JSON.stringify({
            before,
            beforeLedger,
            metrics: {
              cssContentSize: metrics.cssContentSize,
              cssLayoutViewport: metrics.cssLayoutViewport,
              cssVisualViewport: metrics.cssVisualViewport,
            },
            afterMetrics,
            metricsLedger,
            capture,
            afterLedger: await ledger(),
          }),
          contentType: "application/json",
        });
      } finally {
        await session.detach();
      }
    });
  }
}
