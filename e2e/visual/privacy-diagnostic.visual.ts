import type { Page } from "@playwright/test";
import { expect, localOrigin, test } from "../fixtures";
import {
  captureWithGeometry,
  loadVisualFont,
  readCaptureGeometry,
  renderedPlatformFonts,
} from "./font-evidence";

const nodes = { heading: ".content-theme h1", main: "main", footer: "footer" };

async function setup(page: Page, family?: string) {
  expect((await page.goto("/privacy"))?.status()).toBe(200);
  if (family) {
    const count = await page.evaluate((name) => {
      const code = document.querySelectorAll<HTMLElement>(".content-page code");
      for (const element of code) element.style.fontFamily = `${JSON.stringify(name)}, monospace`;
      return code.length;
    }, family);
    expect(count).toBeGreaterThan(0);
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
}

async function ledger(page: Page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll(
      "main, main > *, main section, main h1, main h2, main h3, main h4, main p, main ul, main ol, main li, main table, main .cta, footer",
    );
    const rect = (r: DOMRect, origin?: DOMRect) => ({
      x: r.x - (origin?.x ?? 0),
      y: r.y - (origin?.y ?? 0),
      width: r.width,
      height: r.height,
    });
    const nearby = Array.from(all).findIndex(
      (el, index) => index > 8 && el.matches("p, li") && !el.querySelector("code"),
    );
    if (nearby < 0) throw new Error("Missing nearby non-code text block");
    return [nearby, 8, 28, 30, 31, 32, 35].map((index) => {
      const block = all[index];
      if (!block || !block.matches("p, li") || (index !== nearby && !block.querySelector("code")))
        throw new Error(`Unexpected diagnostic block ${index}`);
      const box = block.getBoundingClientRect();
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const fragments: Array<{
        text: string;
        code: boolean;
        rects: ReturnType<typeof rect>[];
        runs: Array<{ start: number; end: number; rect: ReturnType<typeof rect> }>;
      }> = [];
      while (walker.nextNode()) {
        const text = walker.currentNode;
        if (!text.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        const rects = Array.from(range.getClientRects(), (r) => rect(r, box));
        const runs: Array<{ start: number; end: number; rect: ReturnType<typeof rect> }> = [];
        for (let i = 0; i < text.textContent.length; i++) {
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          const r = range.getBoundingClientRect();
          const previous = runs[runs.length - 1];
          if (previous && previous.rect.y === r.y - box.y) {
            previous.end = i + 1;
            previous.rect.width = r.right - box.x - previous.rect.x;
          } else runs.push({ start: i, end: i + 1, rect: rect(r, box) });
        }
        fragments.push({
          text: text.textContent,
          code: Boolean(text.parentElement?.closest("code")),
          rects,
          runs,
        });
      }
      return {
        index,
        tag: block.tagName,
        box: rect(box),
        fragments,
        code: Array.from(block.querySelectorAll("code"), (el) => {
          const style = getComputedStyle(el);
          return {
            text: el.textContent,
            box: rect(el.getBoundingClientRect(), box),
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
}

async function codeFonts(page: Page) {
  const count = await page.evaluate(() => {
    const elements = document.querySelectorAll(".content-page code");
    elements.forEach((el, index) => el.setAttribute("data-diagnostic-code", String(index)));
    return elements.length;
  });
  expect(count).toBeGreaterThan(0);
  const fonts = [];
  for (let index = 0; index < count; index++)
    fonts.push(await renderedPlatformFonts(page, `[data-diagnostic-code="${index}"]`));
  return fonts;
}

for (const [viewport, size] of [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`privacy named mono diagnostic @ ${viewport}`, async ({ page, browser }, testInfo) => {
    await page.setViewportSize(size);
    await setup(page);
    const before = await readCaptureGeometry(page, nodes);
    const beforeLedger = await ledger(page);
    const afterLedgerGeometry = await readCaptureGeometry(page, nodes);
    const first = await captureWithGeometry(page, nodes, {
      animations: "disabled",
      caret: "hide",
      scale: "css",
    });
    const afterLedger = await ledger(page);
    const fonts = await codeFonts(page);
    await testInfo.attach("generic-first", { body: first.png, contentType: "image/png" });
    await testInfo.attach("generic-ledger", {
      body: JSON.stringify({
        before,
        beforeLedger,
        afterLedgerGeometry,
        first: { before: first.before, after: first.after, dimensions: first.dimensions },
        afterLedger,
        fonts,
      }),
      contentType: "application/json",
    });

    // Only select an explicitly known local monospaced family from B's glyph evidence.
    const used = fonts.flat().filter((f) => f.glyphCount > 0);
    const families = [...new Set(used.map((f) => f.familyName))];
    const knownMono = new Set([
      "DejaVu Sans Mono",
      "Liberation Mono",
      "Nimbus Mono PS",
      "Noto Sans Mono",
    ]);
    expect(used.length).toBeGreaterThan(0);
    expect(fonts.every((entry) => entry.some((f) => f.glyphCount > 0))).toBe(true);
    expect(used.every((f) => !f.isCustomFont)).toBe(true);
    expect(families).toHaveLength(1);
    expect(knownMono.has(families[0]!)).toBe(true);
    const context = await browser.newContext({ baseURL: localOrigin, viewport: size });
    try {
      const named = await context.newPage();
      await setup(named, families[0]);
      const namedBefore = await readCaptureGeometry(named, nodes);
      const namedBeforeLedger = await ledger(named);
      const namedAfterLedgerGeometry = await readCaptureGeometry(named, nodes);
      const capture = await captureWithGeometry(named, nodes, {
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
      const namedAfterLedger = await ledger(named);
      const second = await captureWithGeometry(named, nodes, {
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
      const namedFonts = await codeFonts(named);
      await testInfo.attach("named-first", { body: capture.png, contentType: "image/png" });
      await testInfo.attach("named-second", { body: second.png, contentType: "image/png" });
      await testInfo.attach("named-ledger", {
        body: JSON.stringify({
          before: namedBefore,
          beforeLedger: namedBeforeLedger,
          afterLedgerGeometry: namedAfterLedgerGeometry,
          first: { before: capture.before, after: capture.after, dimensions: capture.dimensions },
          afterLedger: namedAfterLedger,
          second: { before: second.before, after: second.after, dimensions: second.dimensions },
          fonts: namedFonts,
        }),
        contentType: "application/json",
      });
      expect
        .soft(
          namedFonts.map((entry) =>
            entry
              .filter((f) => f.glyphCount > 0)
              .map((f) => f.postScriptName)
              .sort(),
          ),
        )
        .toEqual(
          fonts.map((entry) =>
            entry
              .filter((f) => f.glyphCount > 0)
              .map((f) => f.postScriptName)
              .sort(),
          ),
        );
      expect.soft(namedAfterLedger).toEqual(namedBeforeLedger);
      expect.soft(namedAfterLedgerGeometry).toEqual(namedBefore);
      expect.soft(capture.before).toEqual(namedBefore);
      expect.soft(capture.after).toEqual(capture.before);
      expect
        .soft(capture.dimensions)
        .toEqual({ width: size.width, height: capture.before.document.scrollHeight });
      expect.soft(second.before).toEqual(capture.after);
      expect.soft(second.after).toEqual(capture.after);
      expect.soft(second.dimensions).toEqual(capture.dimensions);
      expect.soft(second.png.equals(capture.png)).toBe(true);
    } finally {
      await context.close();
    }
  });
}
