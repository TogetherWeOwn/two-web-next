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
  for (const arm of ["original", "inherit"] as const) {
    test(`privacy inline diagnostic ${arm} @ ${viewport}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      expect((await page.goto("/privacy"))?.status()).toBe(200);
      if (arm === "inherit") {
        await page.addStyleTag({ content: ".content-page code { font-family: inherit; }" });
      }
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
          (f) =>
            f.isCustomFont && f.glyphCount > 0 && f.postScriptName === "MonaSansExtraLight-Regular",
        ),
      ).toBe(true);

      const ledger = () =>
        page.evaluate(() => {
          const all = document.querySelectorAll(
            "main, main > *, main section, main h1, main h2, main h3, main h4, main p, main ul, main ol, main li, main table, main .cta, footer",
          );
          const rect = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
          const nearby = Array.from(all).findIndex(
            (el, index) => index > 8 && el.matches("p, li") && !el.querySelector("code"),
          );
          if (nearby < 0) throw new Error("Missing nearby non-code text block");
          return [nearby, 8, 28, 30, 31, 32, 35].map((index) => {
            const block = all[index];
            if (
              !block ||
              !block.matches("p, li") ||
              (index !== nearby && !block.querySelector("code"))
            )
              throw new Error(`Unexpected diagnostic block ${index}`);
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            const fragments: Array<{
              text: string;
              code: boolean;
              rects: ReturnType<typeof rect>[];
            }> = [];
            while (walker.nextNode()) {
              const text = walker.currentNode;
              if (!text.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              fragments.push({
                text: text.textContent,
                code: Boolean(text.parentElement?.closest("code")),
                rects: Array.from(range.getClientRects(), rect),
              });
            }
            return {
              index,
              tag: block.tagName,
              box: rect(block.getBoundingClientRect()),
              fragments,
              code: Array.from(block.querySelectorAll("code"), (el) => {
                const style = getComputedStyle(el);
                return {
                  text: el.textContent,
                  box: rect(el.getBoundingClientRect()),
                  family: style.fontFamily,
                  size: style.fontSize,
                  lineHeight: style.lineHeight,
                  verticalAlign: style.verticalAlign,
                  display: style.display,
                };
              }),
            };
          });
        });
      const before = await readCaptureGeometry(page, nodes);
      const beforeLedger = await ledger();
      const afterLedgerGeometry = await readCaptureGeometry(page, nodes);
      const capture = await captureWithGeometry(page, nodes, {
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
      const afterLedger = await ledger();
      await testInfo.attach(`diagnostic-${arm}-first-png`, {
        body: capture.png,
        contentType: "image/png",
      });
      await testInfo.attach(`diagnostic-${arm}-ledger`, {
        body: JSON.stringify({
          before,
          beforeLedger,
          afterLedgerGeometry,
          capture: { before: capture.before, after: capture.after, dimensions: capture.dimensions },
          afterLedger,
        }),
        contentType: "application/json",
      });
    });
  }
}
