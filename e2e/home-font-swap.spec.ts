import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, localOrigin } from "./fixtures";
import type { Page } from "@playwright/test";
import { LEAF_CRITICAL_CSS_SHA256 } from "../src/leaf-critical-css";
import { pageShellFixture } from "../test/helpers/page-shells";

const CHAKRA_700_PATH = "/fonts/chakra-petch-latin-700-normal.woff2";
const CHAKRA_700_BYTES = readFileSync(resolve("public", CHAKRA_700_PATH.slice(1)));

type FontSwapMetrics = {
  linesBefore: number;
  linesAfter: number;
  clsBefore: number;
  clsAfter: number;
};

async function captureFontSwap(
  page: Page,
  html: string,
  csp: string,
  width: number,
): Promise<FontSwapMetrics> {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => {
    type ShiftEntry = { hadRecentInput: boolean; value: number };
    const browser = globalThis as any;
    let cls = 0;
    const observer = new browser.PerformanceObserver((list: any) => {
      for (const entry of list.getEntries() as ShiftEntry[]) {
        if (!entry.hadRecentInput) cls += entry.value;
      }
    });
    observer.observe({ type: "layout-shift", buffered: true });
    Object.assign(browser, {
      __fontSwapCls: () => {
        for (const entry of observer.takeRecords() as ShiftEntry[]) {
          if (!entry.hadRecentInput) cls += entry.value;
        }
        return cls;
      },
    });
  });

  let releaseFont!: () => void;
  const fontBytes = new Promise<Buffer>((resolveFont) => {
    releaseFont = () => resolveFont(CHAKRA_700_BYTES);
  });
  let signalFontRequest!: () => void;
  const fontRequested = new Promise<void>((resolveRequest) => {
    signalFontRequest = resolveRequest;
  });
  await page.route(`**${CHAKRA_700_PATH}`, async (route) => {
    signalFontRequest();
    await route.fulfill({ body: await fontBytes, contentType: "font/woff2" });
  });
  await page.route(`${localOrigin}/`, (route) =>
    route.fulfill({
      status: 200,
      body: html,
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp },
    }),
  );

  await page.goto(localOrigin, { waitUntil: "domcontentloaded" });
  await fontRequested;
  await page.waitForFunction(
    () => (globalThis as any).performance.getEntriesByName("first-contentful-paint").length > 0,
  );
  expect(
    await page.evaluate(() => (globalThis as any).document.fonts.check('700 48px "Chakra Petch"')),
  ).toBe(false);

  const linesBefore = await lineCount(page);
  const clsBefore = await readCls(page);
  releaseFont();
  await page.evaluate(async () => {
    await (globalThis as any).document.fonts.ready;
    await new Promise<void>((resolveFrame) =>
      (globalThis as any).requestAnimationFrame(() =>
        (globalThis as any).requestAnimationFrame(() => resolveFrame()),
      ),
    );
  });
  expect(
    await page.evaluate(() => (globalThis as any).document.fonts.check('700 48px "Chakra Petch"')),
  ).toBe(true);

  return {
    linesBefore,
    linesAfter: await lineCount(page),
    clsBefore,
    clsAfter: await readCls(page),
  };
}

async function lineCount(page: Page) {
  return page.locator("#home-heading").evaluate((heading: any) => {
    const text = heading.firstChild;
    if (!text || text.nodeType !== 3) throw new Error("Expected plain-text hero heading");
    const range = (globalThis as any).document.createRange();
    const lineTops = new Set<number>();
    for (let offset = 0; offset < text.textContent!.length; offset += 1) {
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      for (const rect of range.getClientRects()) lineTops.add(Math.round(rect.top));
    }
    return lineTops.size;
  });
}

async function readCls(page: Page) {
  return page.evaluate(() => ((globalThis as any).__fontSwapCls as () => number)());
}

async function homepageFixture() {
  const response = await pageShellFixture().request("/");
  expect(response.status).toBe(200);
  const html = await response.text();
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain(`style-src 'self' 'sha256-${LEAF_CRITICAL_CSS_SHA256}'`);
  expect(csp).not.toContain("unsafe-inline");
  return { html, csp };
}

test("homepage mobile Chakra Petch font swap preserves hero layout after FCP", async ({ page }) => {
  const { html, csp } = await homepageFixture();

  for (const width of [340, 360, 390, 412]) {
    const metrics = await captureFontSwap(page, html, csp, width);

    expect(metrics.linesBefore, `hero should render at ${width}px`).toBeGreaterThan(0);
    expect(
      metrics.linesAfter,
      `hero line count should remain stable at ${width}px; got ${JSON.stringify(metrics)}`,
    ).toBe(metrics.linesBefore);
    expect(
      metrics.clsAfter - metrics.clsBefore,
      `font swap CLS should stay within budget at ${width}px; got ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(0.01);
  }
});

test("font-swap acceptance detects a deliberately incorrect fallback metric", async ({ page }) => {
  const { html, csp } = await homepageFixture();
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  expect(style).not.toBeNull();
  // Break whatever metric the fallback ships with, rather than pinning one
  // tuned value: a hard-coded metric silently stops mutating anything the
  // day the fallback is retuned, and the control passes without testing it.
  const fallbackMetric = /size-adjust:\s*[\d.]+%/;
  expect(style![1], "inline CSS should carry a size-adjust fallback metric to break").toMatch(
    fallbackMetric,
  );
  const brokenCss = style![1]!.replace(fallbackMetric, "size-adjust: 100%");
  expect(brokenCss, "breaking the fallback metric should change the inline CSS").not.toBe(
    style![1],
  );
  expect(brokenCss).toContain("size-adjust: 100%");
  const brokenHash = createHash("sha256").update(brokenCss).digest("base64");
  const brokenHtml = html.replace(style![0], `<style>${brokenCss}</style>`);
  const brokenCsp = csp.replace(LEAF_CRITICAL_CSS_SHA256, brokenHash);

  const sensitiveWidthMetrics = [];
  for (const width of [340, 360]) {
    sensitiveWidthMetrics.push(await captureFontSwap(page, brokenHtml, brokenCsp, width));
  }
  expect(
    sensitiveWidthMetrics.some(
      (metrics) =>
        metrics.linesAfter !== metrics.linesBefore || metrics.clsAfter - metrics.clsBefore > 0.01,
    ),
    `bad fallback should regress at 340px or 360px; got ${JSON.stringify(sensitiveWidthMetrics)}`,
  ).toBe(true);
});
