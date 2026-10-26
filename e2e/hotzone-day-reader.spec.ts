// Acceptance-owned real SSR fixture journeys; no Worker, DB or remote traffic.
// Run: NODE_OPTIONS=--import=tsx TZ=America/Los_Angeles npx playwright test --config=e2e hotzone-day-reader.spec.ts --workers=1 --reporter=json
// HZD_SCREENSHOT_DIR captures baseline/implemented states without updating goldens.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test, type Page, type Locator } from "@playwright/test";
import {
  compilePeriodKit,
  periodOrigin,
  type PeriodKit,
  type PeriodTwin,
} from "../test/helpers/hotzone-period-picker";
import { dayRows, renderDayRequest } from "../test/helpers/hotzone-day-reader";

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
      // Old January is empty, recent quarter carries the asymmetric fixture.
      const result = await renderDayRequest(twin, `${url.pathname}${url.search}`, kit, {
        fixture: url.searchParams.get("season") === "2025-01" ? "empty" : "populated",
      });
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
        contentType: "text/html; charset=utf-8",
        body: result.html.replace("</head>", `<style>${css}</style></head>`),
      });
    }
    const asset = resolve(root, "public", `.${url.pathname}`);
    if (!asset.startsWith(join(root, "public") + "/") || !existsSync(asset)) return route.abort();
    return route.fulfill({ path: asset });
  });
  return requests;
}
async function capture(page: Page, twin: string, width: number, state: string) {
  const directory = process.env.HZD_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${twin}-${width}-${state}.png`),
    fullPage: true,
    animations: "disabled",
  });
}
async function tabTo(page: Page, target: Locator) {
  for (let n = 0; n < 60; n += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((node) => node === node.ownerDocument.activeElement)) break;
  }
  await expect(target).toBeFocused();
}
async function reader(page: Page, name: string, counts: number[], width: number) {
  const table = page.locator("main table");
  await expect(
    table.locator("thead th"),
    "HZD_BROWSER_TABLE: render Hour UTC / Count, not the 25-column week",
  ).toHaveCount(2, { timeout: 1000 });
  await expect(table.locator("caption")).toContainText(name);
  await expect(table.locator("thead th").first()).toContainText(/Hour.*UTC/i);
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(24);
  for (let hour = 0; hour < 24; hour += 1) {
    const cells = rows.nth(hour).locator("th,td");
    await expect(cells).toHaveCount(2);
    await expect(cells.first()).toHaveText(
      new RegExp(`^${String(hour).padStart(2, "0")}(?::00)?(?: UTC)?$`),
    );
    await expect(cells.last()).toHaveText(String(counts[hour]));
  }
  expect(await table.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.locator("html").evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  const box = await table.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`${twin} ${viewport.width} HZD_B01: default full week retains labelled keyboard scrolling; capture real states`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const requests = await fixture(page, twin);
      await page.goto(`${periodOrigin}/hotzones/joins?season=2026-Q1`);
      const table = page.locator("main table");
      await expect(table.locator("thead th")).toHaveCount(25);
      await expect(table.locator("tbody tr")).toHaveCount(7);
      const region = page.getByRole("region", { name: /join activity/i });
      await expect(region).toHaveAttribute("tabindex", "0");
      await tabTo(page, region);
      await page.keyboard.press("ArrowRight");
      if (viewport.width === 390)
        expect(await region.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      expect(await page.locator("html").evaluate((node) => node.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      await capture(page, twin, viewport.width, "full");
      // Observation-only baseline shots: do not invent a day-reader after image
      // on a source head where that mode does not exist yet.
      for (const [state, path] of [
        ["requested-day", "/hotzones/joins?season=2026-Q1&day=sun"],
        ["empty-requested-day", "/hotzones/joins?season=2025-01&day=sun"],
        ["estimated-voice", "/hotzones/voice?season=2026-Q1&day=sat"],
        ["estimated-games", "/hotzones/games?season=2026-Q1&day=sat"],
      ]) {
        const response = await page.goto(`${periodOrigin}${path}`);
        expect(response?.status()).toBe(200);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await capture(page, twin, viewport.width, state!);
      }
      expect(requests.every((request) => request.method === "GET" && request.status === 200)).toBe(
        true,
      );
    });

    test(`${twin} ${viewport.width} HZD_B02: no-JS native keyboard weekday/period/full-week journey`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const requests = await fixture(page, twin);
      await page.goto(`${periodOrigin}/hotzones/joins?season=2026-Q1`);
      const select = page.locator('select[name="day"]');
      await expect(
        select,
        "HZD_BROWSER_CONTROL: add native labelled weekday selection",
      ).toHaveCount(1, { timeout: 1000 });
      await expect(page.getByLabel(/day/i).and(select)).toBeVisible();
      await tabTo(page, select);
      // Discover option order, then choose only with keyboard events. No
      // type-ahead timeout, script-driven change, or pointer interaction.
      const sundayIndex = await select
        .locator("option")
        .evaluateAll((options) =>
          options.findIndex((option) => option.getAttribute("value") === "sun"),
        );
      expect(sundayIndex).toBeGreaterThanOrEqual(0);
      await page.keyboard.press("Home");
      for (let n = 0; n < sundayIndex; n += 1) await page.keyboard.press("ArrowDown");
      await expect(select).toHaveValue("sun");
      const submit = select.locator("xpath=ancestor::form").getByRole("button");
      await tabTo(page, submit);
      await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
      expect(new URL(page.url()).searchParams.get("season")).toBe("2026-Q1");
      expect(new URL(page.url()).searchParams.getAll("day")).toEqual(["sun"]);
      await reader(page, "Sunday", dayRows[0]!, viewport.width);
      await capture(page, twin, viewport.width, "day-keyboard");
      const period = page.locator('input[name="season"]');
      await tabTo(page, period);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText("2025-01");
      await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
      expect(new URL(page.url()).searchParams.getAll("day")).toEqual(["sun"]);
      await reader(page, "Sunday", Array(24).fill(0), viewport.width);
      await expect(page.locator("main")).toContainText(/90 days.*0 joins.*scheduled gatherings/i);
      await capture(page, twin, viewport.width, "empty-keyboard");
      const month = page.getByRole("link", { name: "This month", exact: true });
      await tabTo(page, month);
      await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
      expect(new URL(page.url()).searchParams.get("season")).toBe("2026-04");
      expect(new URL(page.url()).searchParams.getAll("day")).toEqual(["sun"]);
      const full = page.getByRole("link", {
        name: /^(?:return to |back to |show |view )?(?:the )?full week$/i,
      });
      await tabTo(page, full);
      await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
      expect(new URL(page.url()).searchParams.has("day")).toBe(false);
      expect(new URL(page.url()).searchParams.get("season")).toBe("2026-04");
      await expect(page.locator("main table thead th")).toHaveCount(25);
      expect(requests.every((request) => request.method === "GET" && request.status === 200)).toBe(
        true,
      );
    });
  }
}
