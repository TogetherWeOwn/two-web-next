// Author-owned local renderer journeys, auto-discovered by browser-smoke.
// NODE_OPTIONS=--import=tsx npx playwright test --config=e2e/adjacent-preview-fixtures.config.ts
// ADJACENT_PREVIEW_SCREENSHOT_DIR captures the real BEFORE/AFTER fixtures.
import { expect, test, type BrowserContext } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  adjacentEvent,
  adjacentKey,
  previewNeighbors,
  renderAdjacentDetail,
  type DetailTwin,
} from "../test/helpers/event-adjacent-preview";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "https://adjacent.example.test";
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("@tailwindcss/node") as {
  compile(
    css: string,
    options: { base: string; onDependency: () => void },
  ): Promise<{
    build(candidates: string[]): string;
  }>;
};
const ids = ["event-series-previous", "event-series-next", "event-previous", "event-next"];
const longTitle = `Community night ${"UnbrokenTitle".repeat(18)}`;
const longVenue = `Venue ${"UnbrokenVenue".repeat(20)} Café 東京`;
const kitSheets = new Map<string, string>();

async function mount(context: BrowserContext, twin: DetailTwin, long = false) {
  const destination = adjacentEvent(30, { title: longTitle, location: longVenue });
  const html = await renderAdjacentDetail(
    twin,
    long
      ? {
          neighbors: { previous: destination, next: destination },
        }
      : {},
  );
  let rootCss = "";
  if (twin === "Kit") {
    if (!kitSheets.has(html)) {
      const candidates = [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/));
      const compiler = await compile(readFileSync(join(root, "web/src/app.css"), "utf8"), {
        base: join(root, "web/src"),
        onDependency: () => {},
      });
      kitSheets.set(html, compiler.build(candidates));
    }
    rootCss = kitSheets.get(html)!;
  }
  const navigated: string[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") return route.abort("blockedbyclient");
    if (url.pathname.startsWith("/e/")) {
      navigated.push(url.pathname);
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: html.replace("</head>", `<style>${rootCss}</style></head>`),
      });
    }
    // Real shipped styles, fonts and native islands. Every other request is
    // refused, including Discord and live event/attendee APIs.
    const asset = resolve(root, "public", url.pathname.slice(1));
    const type = url.pathname.endsWith(".css")
      ? "text/css"
      : url.pathname.endsWith(".js")
        ? "text/javascript"
        : url.pathname.endsWith(".woff2")
          ? "font/woff2"
          : url.pathname.endsWith(".svg")
            ? "image/svg+xml"
            : url.pathname.endsWith(".png")
              ? "image/png"
              : null;
    if (
      type &&
      asset.startsWith(join(root, "public/")) &&
      existsSync(asset) &&
      statSync(asset).isFile()
    )
      return route.fulfill({ contentType: type, body: readFileSync(asset) });
    return route.fulfill({ status: 404, body: "No fixture" });
  });
  return navigated;
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const javaScriptEnabled of [false, true]) {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      const label = `${twin} JS=${javaScriptEnabled} ${viewport.width}`;
      test(`AP10 RED ${label}: visible and accessibly named previews without device-zone conversion`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled,
          viewport,
          timezoneId: "Pacific/Auckland",
          serviceWorkers: "block",
        });
        try {
          await mount(context, twin);
          const page = await context.newPage();
          await page.goto(`${origin}/e/${adjacentKey(20)}`);
          if (process.env.ADJACENT_PREVIEW_SCREENSHOT_DIR && !javaScriptEnabled) {
            mkdirSync(process.env.ADJACENT_PREVIEW_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({
              path: join(
                process.env.ADJACENT_PREVIEW_SCREENSHOT_DIR,
                `${twin}-${viewport.width}.png`,
              ),
              fullPage: true,
            });
          }
          await expect(
            page.getByRole("navigation", { name: "Series events", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("navigation", { name: "More events", exact: true }),
          ).toBeVisible();
          for (const id of ids) {
            const anchor = page.getByTestId(id);
            const previous = id.endsWith("previous");
            const when = previous
              ? "Friday, 7 June 2030 at 15:00 GMT-04:00"
              : "Friday, 21 June 2030 at 20:00 GMT+01:00";
            await expect(anchor.locator("time")).toBeVisible();
            await expect(anchor.locator("time")).toHaveText(when);
            await expect(anchor).toContainText(previous ? "West room" : "East room");
            await expect(anchor).toHaveAccessibleName(
              new RegExp(
                `${previous ? "Previous" : "Next"}.*Friday game night.*${when.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
              ),
            );
          }
        } finally {
          await context.close();
        }
      });

      test(`AP11 RED ${label}: long title and venue wrap instead of clipping or horizontal scroll`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled,
          viewport,
          serviceWorkers: "block",
        });
        try {
          await mount(context, twin, true);
          const page = await context.newPage();
          await page.goto(`${origin}/e/${adjacentKey(20)}`);
          for (const id of ids) {
            const anchor = page.getByTestId(id);
            await expect(anchor).toContainText(longTitle);
            await expect(anchor).toContainText(longVenue);
            await expect(anchor).toHaveCSS("text-overflow", "clip");
            const bounds = await anchor.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
          }
          expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(
            true,
          );
        } finally {
          await context.close();
        }
      });

      test(`AP12 CONTROL ${label}: Tab and Enter follow unchanged native directional links`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled,
          viewport,
          serviceWorkers: "block",
        });
        try {
          const navigated = await mount(context, twin);
          const page = await context.newPage();
          await page.goto(`${origin}/e/${adjacentKey(20)}`);
          await page.getByTestId(ids[0]!).focus();
          for (const id of ids.slice(1)) {
            await page.keyboard.press("Tab");
            await expect(page.getByTestId(id)).toBeFocused();
          }
          await Promise.all([
            page.waitForURL(`${origin}/e/${previewNeighbors.next!.eventKey}`),
            page.keyboard.press("Enter"),
          ]);
          expect(navigated).toEqual([`/e/${adjacentKey(20)}`, `/e/${adjacentKey(30)}`]);
        } finally {
          await context.close();
        }
      });
    }
  }
}
