// Hermetic real SSR fixtures. No app server, DB, sessions or remote analytics.
// Run: NODE_OPTIONS=--import=tsx TZ=America/Los_Angeles npx playwright test --config=e2e hotzone-period-picker.spec.ts --workers=1
// Normal CI also discovers this file with its existing e2e/*.spec.ts glob.
// PERIOD_SCREENSHOT_DIR captures selected/reset/error states for visual review.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { periodNow, periodPaths } from "../test/fixtures/hotzone-period-picker";
import {
  compilePeriodKit,
  periodOrigin,
  renderPeriodRequest,
  type PeriodKit,
  type PeriodTwin,
} from "../test/helpers/hotzone-period-picker";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(join(root, "web/package.json"));
const { compile: compileTailwind } = webRequire("@tailwindcss/node");
let kit: PeriodKit;
let sharedCss: string;
let kitCss: { build: (candidates: string[]) => string };

test.use({ javaScriptEnabled: false, serviceWorkers: "block", timezoneId: "America/Los_Angeles" });
test.beforeAll(async () => {
  kit = await compilePeriodKit();
  sharedCss = ["styles.css", "theme.css", "schedule-theme.css"]
    .map((path) => readFileSync(join(root, "public", path), "utf8"))
    .join("\n");
  kitCss = await compileTailwind(readFileSync(join(root, "web/src/app.css"), "utf8"), {
    base: join(root, "web/src"),
    onDependency: () => {},
  });
});
test.afterAll(() => kit?.dispose());

async function fixture(page: Page, twin: PeriodTwin) {
  const requests: { method: string; path: string; status: number }[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== periodOrigin) return route.abort();
    if (request.isNavigationRequest() && url.pathname.startsWith("/hotzones")) {
      const result = await renderPeriodRequest(
        twin,
        `${url.pathname}${url.search}`,
        kit,
        periodNow,
      );
      requests.push({
        method: request.method(),
        path: `${url.pathname}${url.search}`,
        status: result.status,
      });
      const candidates = [...result.html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
        match[1]!.split(/\s+/),
      );
      const css =
        twin === "Kit" ? `${sharedCss}\n${kitCss.build(candidates)}\n${kit.css}` : sharedCss;
      expect(css).not.toContain("</style");
      return route.fulfill({
        status: result.status,
        contentType: "text/html",
        body: result.html.replace("</head>", `<style>${css}</style></head>`),
      });
    }
    const asset = resolve(root, "public", `.${url.pathname}`);
    if (!asset.startsWith(join(root, "public") + "/") || !existsSync(asset)) return route.abort();
    return route.fulfill({ path: asset });
  });
  return requests;
}

async function capture(page: Page, twin: string, path: string, width: number, state: string) {
  if (!process.env.PERIOD_SCREENSHOT_DIR) return;
  mkdirSync(process.env.PERIOD_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: join(
      process.env.PERIOD_SCREENSHOT_DIR,
      `${twin}-${path.replace(/\//g, "-")}-${width}-${state}.png`,
    ),
    fullPage: true,
    animations: "disabled",
  });
}

async function tabTo(page: Page, selector: string) {
  const target = page.locator(selector);
  for (let n = 0; n < 40; n += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((node) => node === node.ownerDocument.activeElement)) break;
  }
  await expect(target).toBeFocused();
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const path of periodPaths) {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      test(`${twin} ${path} ${viewport.width}: native keyboard apply, UTC shortcuts and route-local reset`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const requests = await fixture(page, twin);
        await page.goto(`${periodOrigin}${path}?season=2026-02`);
        await capture(page, twin, path, viewport.width, "selected");
        const input = page.locator('input[name="season"]');
        await expect(input).toHaveCount(1, { timeout: 1000 });
        await expect(page.getByLabel(/period|season/i).and(input)).toBeVisible();
        await expect(input).toHaveValue("2026-02");
        await tabTo(page, 'input[name="season"]');
        for (const value of ["2026", "2026-04", "2026-Q2", "all"]) {
          if (!(await input.evaluate((node) => node === node.ownerDocument.activeElement))) {
            await tabTo(page, 'input[name="season"]');
          }
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.insertText(value);
          await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
          const applied = new URL(page.url());
          expect(applied.pathname).toBe(path);
          // Explicit all is still accepted by the existing grammar. Its
          // canonical URL and reset/All anchor omit redundant query state.
          expect(applied.searchParams.get("season") ?? "all").toBe(value);
          expect([...applied.searchParams.keys()].every((key) => key === "season")).toBe(true);
          await expect(input).toHaveValue(value);
          expect(requests.at(-1)?.method).toBe("GET");
          expect(requests.at(-1)?.status).toBe(200);
        }
        for (const [label, value] of [
          ["This month", "2026-04"],
          ["This quarter", "2026-Q2"],
        ]) {
          const anchor = page.getByRole("link", { name: label, exact: true });
          await expect(anchor).toHaveAttribute("href", `${path}?season=${value}`);
          await Promise.all([page.waitForNavigation(), anchor.press("Enter")]);
          expect(new URL(page.url()).pathname).toBe(path);
          await expect(input).toHaveValue(value!);
        }
        const all = page.getByRole("link", { name: "All available data", exact: true });
        await expect(all).toHaveAttribute("href", path);
        await Promise.all([page.waitForNavigation(), all.press("Enter")]);
        expect(page.url()).toBe(`${periodOrigin}${path}`);
        await expect(input).toHaveValue("all");
        await capture(page, twin, path, viewport.width, "reset");
        const width = await page.locator("html").evaluate((node) => node.scrollWidth);
        expect(width).toBeLessThanOrEqual(viewport.width);
        const form = input.locator("xpath=ancestor::form");
        const controls = form.locator("input,button,select,a");
        for (const control of await controls.all()) {
          if (!(await control.isVisible())) continue;
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        }
        await tabTo(page, 'input[name="season"]');
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.insertText("not-a-season");
        const [refusal] = await Promise.all([
          page.waitForNavigation(),
          page.keyboard.press("Enter"),
        ]);
        expect(refusal?.status()).toBe(400);
        expect(requests.at(-1)).toEqual({
          method: "GET",
          path: `${path}?season=not-a-season`,
          status: 400,
        });
        await capture(page, twin, path, viewport.width, "submitted-error");
      });

      test(`${twin} ${path} ${viewport.width}: invalid bookmark remains a refusal, not all data`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const requests = await fixture(page, twin);
        const reset = await page.goto(`${periodOrigin}${path}`);
        expect(reset?.status()).toBe(200);
        await capture(page, twin, path, viewport.width, "bare-all");
        const response = await page.goto(`${periodOrigin}${path}?season=not-a-season`);
        expect(response?.status()).toBe(400);
        expect(requests).toEqual([
          { method: "GET", path, status: 200 },
          { method: "GET", path: `${path}?season=not-a-season`, status: 400 },
        ]);
        await expect(page.locator('input[name="season"][value="all"]')).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await capture(page, twin, path, viewport.width, "error");
      });
    }
  }
}
