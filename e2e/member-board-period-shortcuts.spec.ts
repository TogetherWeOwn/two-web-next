// Acceptance-owned native browser journey, discovered by e2e/*.spec.ts in CI.
// Hermetic: real route/load/page, recorded SQL fixture, no server or remote data.
// Local: NODE_OPTIONS=--import=tsx TZ=America/Los_Angeles npx playwright test --config=e2e member-board-period-shortcuts.spec.ts --workers=1
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  boardPeriodHarness,
  compileBoardPeriodKit,
  ORIGIN,
  type BoardPeriodKit,
  type Twin,
} from "../test/helpers/member-board-period-shortcuts";

const root = fileURLToPath(new URL("../", import.meta.url));
const PATH = "/leaderboards/members";
const NOW = Date.parse("2032-04-01T00:00:00.000Z");
let kit: BoardPeriodKit;
let sharedCss: string;
let kitCss: { build: (candidates: string[]) => string };
test.use({ javaScriptEnabled: false, serviceWorkers: "block", timezoneId: "America/Los_Angeles" });
test.beforeAll(async () => {
  kit = await compileBoardPeriodKit();
  sharedCss = ["styles.css", "theme-tokens.css", "theme.css", "schedule-theme.css"]
    .map((name) => readFileSync(join(root, "public", name), "utf8"))
    .join("\n");
  const { compile } = createRequire(join(root, "web/package.json"))("@tailwindcss/node");
  kitCss = await compile(readFileSync(join(root, "web/src/app.css"), "utf8"), {
    base: join(root, "web/src"),
    onDependency: () => {},
  });
});

async function fixture(page: Page, twin: Twin) {
  const h = boardPeriodHarness(kit);
  const requests: { method: string; path: string; status: number }[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (request.isNavigationRequest() && url.pathname === PATH) {
      expect(request.method()).toBe("GET");
      const NativeDate = globalThis.Date;
      // Freeze only application rendering, not Playwright's own wall-clock.
      globalThis.Date = new Proxy(NativeDate, {
        construct(target, args) {
          return Reflect.construct(target, args.length ? args : [NOW]);
        },
        get(target, key) {
          return key === "now" ? () => NOW : Reflect.get(target, key);
        },
      });
      try {
        const result = await h.request(twin, url.pathname + url.search);
        requests.push({
          method: request.method(),
          path: url.pathname + url.search,
          status: result.status,
        });
        const candidates = [...result.html.matchAll(/class="([^"]+)"/g)].flatMap((match) =>
          match[1]!.split(/\s+/),
        );
        const css = sharedCss + (twin === "Kit" ? `\n${kitCss.build(candidates)}\n${kit.css}` : "");
        expect(css).not.toContain("</style");
        await route.fulfill({
          status: result.status,
          contentType: "text/html",
          body: result.html.replace("</head>", `<style>${css}</style></head>`),
        });
      } finally {
        globalThis.Date = NativeDate;
      }
      return;
    }
    const asset = resolve(root, "public", `.${url.pathname}`);
    if (!asset.startsWith(join(root, "public") + "/") || !existsSync(asset)) return route.abort();
    return route.fulfill({ path: asset });
  });
  return requests;
}

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 50; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((node) => node === node.ownerDocument.activeElement)) break;
  }
  await expect(target).toBeFocused();
}

async function capture(page: Page, twin: Twin, width: number, state: string) {
  const directory = process.env.MEMBER_PERIOD_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: join(directory, `${twin}-${width}-${state}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

for (const twin of ["Hono", "Kit"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`${twin} ${viewport.width}: Tab/Enter chooses each period without JavaScript and keeps game/scope`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const requests = await fixture(page, twin);
      await page.goto(`${ORIGIN}${PATH}?season=2024-Q3&scope=relative&activity=d%26d`);
      await expect(page.locator('input[name="season"]')).toHaveValue("2024-Q3");
      await capture(page, twin, viewport.width, "historical");
      for (const [name, season] of [
        ["This month", "2032-04"],
        ["This quarter", "2032-Q2"],
        ["All time", "all"],
      ] as const) {
        const anchor = page.getByRole("link", { name, exact: true });
        // Fail promptly on absent behavior, not after a navigation timeout.
        await expect(anchor).toHaveCount(1, { timeout: 1000 });
        await expect(anchor).toBeVisible();
        expect(
          await anchor.evaluate((node) => {
            for (let parent = node.parentElement; parent; parent = parent.parentElement) {
              if (parent.getAttribute("aria-current") === "page") return true;
            }
            return false;
          }),
        ).toBe(false);
        await tabTo(page, anchor);
        const box = await anchor.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
        const destination = new URL(page.url());
        expect(destination.pathname).toBe(PATH);
        expect(destination.searchParams.get("season") ?? "all").toBe(season);
        expect(destination.searchParams.get("scope")).toBe("relative");
        expect(destination.searchParams.get("activity")).toBe("d&d");
        await expect(page.locator('input[name="season"]')).toHaveValue(season);
        await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute(
          "aria-current",
          /^(?:page|date|true)$/,
        );
        await expect(page.locator('tbody tr[aria-current="true"]')).toHaveCount(1);
        expect(requests.at(-1)?.status).toBe(200);
        await capture(page, twin, viewport.width, season);
      }
      expect(requests).toHaveLength(4);
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    });

    test(`${twin} ${viewport.width}: historical keyboard form still works and invalid bookmarks remain 400`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const requests = await fixture(page, twin);
      await page.goto(`${ORIGIN}${PATH}?scope=relative&activity=d%26d`);
      const input = page.getByLabel(/season/i).and(page.locator('input[name="season"]'));
      for (const season of ["2024", "2024-02", "2024-Q3", "all"]) {
        await tabTo(page, input);
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.insertText(season);
        await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
        await expect(input).toHaveValue(season);
        const destination = new URL(page.url());
        expect(destination.searchParams.get("season")).toBe(season);
        expect(destination.searchParams.get("scope")).toBe("relative");
        expect(destination.searchParams.get("activity")).toBe("d&d");
        expect(requests.at(-1)?.status).toBe(200);
      }
      await tabTo(page, input);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText("not-a-season");
      const [refused] = await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
      expect(refused?.status()).toBe(400);
      await expect(page.locator("tbody")).toHaveCount(0);
      const bookmark = await page.goto(
        `${ORIGIN}${PATH}?season=2032-Q5&scope=relative&activity=d%26d`,
      );
      expect(bookmark?.status()).toBe(400);
      await expect(page.locator('input[name="season"][value="all"]')).toHaveCount(0);
      expect(requests.every((request) => request.method === "GET")).toBe(true);
    });
  }
}
