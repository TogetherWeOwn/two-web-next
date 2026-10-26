// Real Hono/Kit SSR, fixture SQL, no app server or live data.
// NODE_OPTIONS=--import=tsx TZ=America/Los_Angeles npx playwright test --config=e2e period-browsing.spec.ts --workers=1
// PERIOD_BROWSING_SCREENSHOT_DIR optionally retains baseline/delivery evidence.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { compilePeriodKit, type PeriodKit } from "../test/helpers/hotzone-period-picker";
import {
  boardPeriodHarness,
  compileBoardPeriodKit,
  ORIGIN,
  type BoardPeriodKit,
  type Twin,
} from "../test/helpers/member-board-period-shortcuts";
import { hotzoneBrowsingHarness, namesPeriod } from "../test/helpers/period-browsing";

const root = fileURLToPath(new URL("../", import.meta.url));
const BOARD = "/leaderboards/members";
const PATHS = [BOARD, "/hotzones", "/hotzones/joins", "/hotzones/voice", "/hotzones/games"];
let boardKit: BoardPeriodKit;
let hotzoneKit: PeriodKit;
let sharedCss: string;
let kitCss: { build: (candidates: string[]) => string };
test.use({ javaScriptEnabled: false, serviceWorkers: "block", timezoneId: "America/Los_Angeles" });
test.beforeAll(async () => {
  boardKit = await compileBoardPeriodKit();
  hotzoneKit = await compilePeriodKit();
  sharedCss = ["styles.css", "theme-tokens.css", "theme.css", "schedule-theme.css"]
    .map((file) => readFileSync(join(root, "public", file), "utf8"))
    .join("\n");
  const { compile } = createRequire(join(root, "web/package.json"))("@tailwindcss/node");
  kitCss = await compile(readFileSync(join(root, "web/src/app.css"), "utf8"), {
    base: join(root, "web/src"),
    onDependency: () => {},
  });
});
test.afterAll(() => hotzoneKit?.dispose());

async function fixture(page: Page, twin: Twin) {
  const board = boardPeriodHarness(boardKit);
  const hotzones = hotzoneBrowsingHarness(hotzoneKit);
  const requests: { method: string; path: string; status: number }[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (request.isNavigationRequest() && PATHS.includes(url.pathname)) {
      expect(request.method()).toBe("GET");
      const result = await (url.pathname === BOARD ? board : hotzones).request(
        twin,
        url.pathname + url.search,
      );
      requests.push({
        method: request.method(),
        path: url.pathname + url.search,
        status: result.status,
      });
      const candidates = [...result.html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
        match[1]!.split(/\s+/),
      );
      const css =
        sharedCss +
        (twin === "Kit" ? `\n${kitCss.build(candidates)}\n${boardKit.css}\n${hotzoneKit.css}` : "");
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
function urlFor(path: string, season: string) {
  const query = new URLSearchParams({ season });
  if (path === BOARD) {
    query.set("scope", "relative");
    query.set("activity", "d&d / co-op");
  }
  return `${ORIGIN}${path}?${query}`;
}
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((node) => node === node.ownerDocument.activeElement)) break;
  }
  await expect(target).toBeFocused();
}
async function capture(page: Page, twin: Twin, path: string, width: number, state: string) {
  const dir = process.env.PERIOD_BROWSING_SCREENSHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({
    path: join(dir, `${twin}-${path.replace(/\//g, "-")}-${width}-${state}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const path of PATHS) {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      test(`PB-UI01 ${twin} ${path} ${viewport.width}: keyboard Previous/Next is native and retains context`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const requests = await fixture(page, twin);
        await page.goto(urlFor(path, "2026-01"));
        for (const [direction, selected] of [
          ["Previous", "2025-12"],
          ["Next", "2026-01"],
        ] as const) {
          const link = page.getByRole("link", {
            name: new RegExp(`\\b${direction}\\b`, "i"),
          });
          await expect(
            link,
            `PB_NAV_MISSING: render named native ${direction} destination`,
          ).toHaveCount(1, { timeout: 1000 });
          await expect(link).toBeVisible();
          expect(
            namesPeriod(
              (await link.getAttribute("aria-label")) ?? (await link.innerText()),
              selected,
            ),
            "PB_DESTINATION_UNNAMED: name the linked period",
          ).toBe(true);
          await tabTo(page, link);
          const box = await link.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
          await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
          const destination = new URL(page.url());
          expect(destination.pathname).toBe(path);
          expect(destination.searchParams.get("season")).toBe(selected);
          if (path === BOARD) {
            expect(destination.searchParams.get("scope")).toBe("relative");
            expect(destination.searchParams.get("activity")).toBe("d&d / co-op");
          }
          await expect(page.locator('input[name="season"]')).toHaveValue(selected);
        }
        expect(requests).toHaveLength(3);
        expect(
          requests.every((request) => request.method === "GET" && request.status === 200),
        ).toBe(true);
        await capture(page, twin, path, viewport.width, "implemented-navigation");
      });

      test(`PB-UI-C01 ${twin} ${path} ${viewport.width}: selected/all/boundary controls stay editable and contained`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const requests = await fixture(page, twin);
        for (const [state, season] of [
          ["selected", "2026-01"],
          ["all", "all"],
          ["lower-boundary", "0000-01"],
          ["upper-boundary", "9999-Q4"],
        ] as const) {
          const response = await page.goto(urlFor(path, season));
          expect(response?.status()).toBe(200);
          const input = page.locator('input[name="season"]');
          await expect(input).toHaveValue(season);
          await expect(input).toBeEditable();
          await expect(page.getByRole("link", { name: "This month", exact: true })).toBeVisible();
          await expect(page.getByRole("link", { name: "This quarter", exact: true })).toBeVisible();
          expect(
            await page.locator("html").evaluate((node) => node.scrollWidth),
          ).toBeLessThanOrEqual(viewport.width);
          if (season === "all")
            await expect(page.getByRole("link", { name: /\b(?:previous|next)\b/i })).toHaveCount(0);
          if (season === "0000-01")
            await expect(page.getByRole("link", { name: /\bprevious\b/i })).toHaveCount(0);
          if (season === "9999-Q4")
            await expect(page.getByRole("link", { name: /\bnext\b/i })).toHaveCount(0);
          await capture(page, twin, path, viewport.width, state);
        }
        expect(requests).toHaveLength(4);
      });
    }
  }
}
