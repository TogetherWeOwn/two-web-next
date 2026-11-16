import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

/** Load this exact face before registration; never rewrite styles or tokens. */
export async function loadVisualFont(page: Page, options: { url: string; weight?: string }) {
  const family = `visual-font-${randomUUID().replaceAll("-", "")}`;
  return page.evaluate(
    async ({ family, url, weight }) => {
      const face = new FontFace(family, `url(${JSON.stringify(url)})`, { weight });
      await face.load();
      document.fonts.add(face);
      return { family, status: face.status, weight };
    },
    { family, url: options.url, weight: options.weight ?? "400" },
  );
}

/** Chromium's actual glyph usage, not a computed family or fonts.check result. */
export async function renderedPlatformFonts(page: Page, selector: string) {
  const session = await page.context().newCDPSession(page);
  try {
    const count = await page.locator(selector).count();
    if (count !== 1) throw new Error(`Expected exactly one element, found ${count}: ${selector}`);
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`CDP could not resolve ${selector}`);
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts;
  } finally {
    await session.detach();
  }
}

/** CSS-pixel metrics; selectors must each identify exactly one light-DOM element. */
export async function readCaptureGeometry(page: Page, selectors: Record<string, string>) {
  return page.evaluate((named) => {
    const metrics = (el: HTMLElement) => ({
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      offsetWidth: el.offsetWidth,
      offsetHeight: el.offsetHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
    });
    const nodes: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const [name, selector] of Object.entries(named)) {
      const found = document.querySelectorAll(selector);
      if (found.length !== 1)
        throw new Error(`Expected exactly one ${name}, found ${found.length}: ${selector}`);
      const { x, y, width, height } = found[0]!.getBoundingClientRect();
      nodes[name] = { x, y, width, height };
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: scrollX, y: scrollY },
      body: metrics(document.body),
      document: metrics(document.documentElement),
      nodes,
    };
  }, selectors);
}

/** Viewport-only Chromium capture: no Playwright font-readiness wait. */
export async function captureWithoutFontWait(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { data } = await session.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    return Buffer.from(data, "base64");
  } finally {
    await session.detach();
  }
}

/** Retain the first full-page capture and both measurements: no warmup or retry. */
export async function captureWithGeometry(page: Page, selectors: Record<string, string>) {
  const before = await readCaptureGeometry(page, selectors);
  const png = await page.screenshot({ fullPage: true });
  const after = await readCaptureGeometry(page, selectors);
  const dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  return { png, dimensions, before, after };
}
