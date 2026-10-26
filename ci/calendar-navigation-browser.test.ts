// Independent, unconditional Chromium acceptance; no live DB or external server.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { GAME_ORIGIN, type GameTwin } from "../test/helpers/calendar-game-recovery";
import {
  firstPageName,
  hidePastName,
  lastPageName,
  navigationRouteFixture,
} from "../test/helpers/calendar-navigation-acceptance";

let browser: Browser;
let context: BrowserContext | undefined;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterEach(async () => {
  await context?.close();
  context = undefined;
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(() => __resetAnonEventCacheForTests());
const publicRoot = resolve("public");
const entry = "/events?game=Chess&past=1&page=2";

async function open(twin: GameTwin, path = entry, width = 390, javaScriptEnabled = true) {
  const fixture = navigationRouteFixture();
  const requests: { path: string; fragment: boolean; method: string }[] = [];
  const errors: string[] = [];
  const forbidden: string[] = [];
  let fail = false;
  context = await browser.newContext({
    javaScriptEnabled,
    viewport: { width, height: width === 390 ? 844 : 800 },
    serviceWorkers: "block",
    timezoneId: "UTC",
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== GAME_ORIGIN) {
      forbidden.push(url.origin);
      return route.abort();
    }
    if (url.pathname === "/events") {
      const fragment = request.headers()["x-two-island"] === "events-calendar";
      requests.push({ path: url.pathname + url.search, fragment, method: request.method() });
      if (fail && fragment) {
        fail = false;
        return route.fulfill({ status: 503, contentType: "text/html", body: "Unavailable" });
      }
      const response = await fixture.request(twin, url.pathname + url.search, fragment);
      return route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    }
    const file = resolve(publicRoot, `.${url.pathname}`);
    if (!file.startsWith(`${publicRoot}/`) || !existsSync(file))
      return route.fulfill({ status: 404, body: "" });
    const type: Record<string, string> = {
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
      ".png": "image/png",
    };
    return route.fulfill({
      contentType: type[extname(file)] ?? "application/octet-stream",
      body: readFileSync(file),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(GAME_ORIGIN + path);
  await page.getByTestId("events-game-filter").waitFor();
  await page.evaluate("window.__navigationDocument = true");
  return {
    page,
    requests,
    fixture,
    errors,
    forbidden,
    failNext: () => {
      fail = true;
    },
  };
}
async function keys(page: Page) {
  return page
    .locator('[data-testid="events-list"] [data-testid="event-card"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-event-key")));
}
async function pastVisible(page: Page) {
  return page.getByText("Past navigation gathering 0", { exact: true }).isVisible();
}
async function snapshot(page: Page) {
  return {
    url: page.url(),
    keys: await keys(page),
    past: await pastVisible(page),
    history: await page.evaluate(() => history.length),
    canonical: await page.locator('link[rel="canonical"]').getAttribute("href"),
  };
}
async function usableFocus(page: Page) {
  expect(
    await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (
        !el ||
        el === document.body ||
        !el.isConnected ||
        el.closest('[hidden], [inert], [aria-hidden="true"]')
      )
        return false;
      return el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    }),
  ).toBe(true);
}
async function capture(page: Page, name: string) {
  const dir = process.env.NAVIGATION_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const pager = page.getByTestId("events-pager");
  if (await pager.count()) await pager.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
}
function clean(journey: Awaited<ReturnType<typeof open>>, documents = 1) {
  expect(journey.errors).toEqual([]);
  expect(journey.forbidden).toEqual([]);
  expect(journey.requests.every((r) => r.method === "GET")).toBe(true);
  expect(journey.requests.filter((r) => !r.fragment)).toHaveLength(documents);
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin}: shipped schedule navigation in Chromium`, () => {
    for (const width of [1280, 390]) {
      it(`${width}: CONTROL: a closed preview stays absent until a native Show turn opens it`, async () => {
        const journey = await open(twin, "/events?game=Chess&page=2", width);
        const { page } = journey;
        expect(await pastVisible(page)).toBe(false);
        expect(await page.getByRole("link", { name: hidePastName }).count()).toBe(0);
        await capture(page, `${twin}-${width}-closed-control`);
        await page.getByRole("link", { name: /show past events/i }).click();
        await expect.poll(() => pastVisible(page)).toBe(true);
        expect(new URL(page.url()).searchParams.get("page")).toBe("2");
        expect(new URL(page.url()).searchParams.get("game")).toBe("Chess");
        clean(journey);
      });

      it(`${width}: keyboard Hide commits closed state and Back/Forward restores it without detached focus`, async () => {
        const journey = await open(twin, entry, width);
        const { page } = journey;
        expect(await pastVisible(page)).toBe(true);
        await capture(page, `${twin}-${width}-manual-open`);
        const hide = page.getByRole("link", { name: hidePastName });
        expect(await hide.count()).toBe(1);
        await hide.focus();
        await hide.press("Enter");
        await expect.poll(() => new URL(page.url()).searchParams.has("past")).toBe(false);
        expect(await pastVisible(page)).toBe(false);
        expect(await keys(page)).toEqual(
          Array.from({ length: 20 }, (_, i) => `navigation-${i + 21}`),
        );
        expect(new URL(page.url()).searchParams.get("game")).toBe("Chess");
        expect(await page.locator('form input[name="past"]').count()).toBe(0);
        await usableFocus(page);
        await capture(page, `${twin}-${width}-manual-closed`);
        await page.goBack();
        await expect.poll(() => pastVisible(page)).toBe(true);
        expect(new URL(page.url()).searchParams.get("past")).toBe("1");
        await page.goForward();
        await expect.poll(() => pastVisible(page)).toBe(false);
        expect(await page.evaluate("window.__navigationDocument")).toBe(true);
        clean(journey);
      });

      it(`${width}: first/last keyboard turns preserve scope and do not reload the document`, async () => {
        const journey = await open(twin, "/events?q=Navigation&game=Chess&past=1&page=2", width);
        const { page } = journey;
        await capture(page, `${twin}-${width}-search-middle`);
        const last = page.getByRole("link", { name: lastPageName });
        expect(await last.count()).toBe(1);
        await last.focus();
        await last.press("Enter");
        await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe("3");
        expect(await keys(page)).toEqual([
          "navigation-41",
          "navigation-42",
          "navigation-43",
          "navigation-44",
          "navigation-45",
        ]);
        expect(await page.getByRole("link", { name: lastPageName }).count()).toBe(0);
        await usableFocus(page);
        const first = page.getByRole("link", { name: firstPageName });
        expect(await first.count()).toBe(1);
        await first.focus();
        await first.press("Enter");
        await expect.poll(() => new URL(page.url()).searchParams.has("page")).toBe(false);
        expect((await keys(page))[0]).toBe("navigation-1");
        expect(await page.getByRole("link", { name: firstPageName }).count()).toBe(0);
        expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
          q: "Navigation",
          game: "Chess",
          past: "1",
        });
        await page.goBack();
        await expect.poll(async () => (await keys(page))[0]).toBe("navigation-41");
        expect(new URL(page.url()).searchParams.get("page")).toBe("3");
        await page.goForward();
        await expect.poll(async () => (await keys(page))[0]).toBe("navigation-1");
        expect(new URL(page.url()).searchParams.has("page")).toBe(false);
        expect(await page.evaluate("window.__navigationDocument")).toBe(true);
        clean(journey);
      });

      it(`${width}: far out-of-range recovery reaches page one directly`, async () => {
        const journey = await open(twin, "/events?game=Chess&past=1&page=999", width);
        const { page } = journey;
        expect(await keys(page)).toEqual([]);
        await capture(page, `${twin}-${width}-out-of-range`);
        expect(await page.getByTestId("events-out-of-range").textContent()).toContain("Page 999");
        const first = page.getByRole("link", { name: firstPageName });
        expect(await first.count()).toBe(1);
        await first.focus();
        await first.press("Enter");
        await expect.poll(() => new URL(page.url()).searchParams.has("page")).toBe(false);
        expect((await keys(page))[0]).toBe("navigation-1");
        expect(await page.getByTestId("events-out-of-range").count()).toBe(0);
        await usableFocus(page);
        expect(journey.requests.filter((r) => r.fragment)).toHaveLength(1);
        clean(journey);
      });
    }

    it("CONTROL: existing next/history and search-forced preview work in this real transport", async () => {
      const journey = await open(twin, "/events?game=Chess&page=2");
      const { page } = journey;
      await page.getByTestId("events-pager-next").click();
      await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe("3");
      expect(await keys(page)).toHaveLength(5);
      await page.goBack();
      await expect.poll(async () => (await keys(page)).length).toBe(20);
      expect(new URL(page.url()).searchParams.get("page")).toBe("2");
      await page.getByTestId("events-search").fill("Navigation");
      await page.getByTestId("events-search").press("Enter");
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("Navigation");
      expect(await pastVisible(page)).toBe(true);
      expect(await page.getByRole("link", { name: hidePastName }).count()).toBe(0);
      expect(
        await page.getByRole("link", { name: /continue search in past events/i }).count(),
      ).toBe(1);
      clean(journey);
    });

    it("native/no-JS Hide and boundary recovery agree with enhanced URLs", async () => {
      const journey = await open(twin, entry, 390, false);
      const { page } = journey;
      const hide = page.getByRole("link", { name: hidePastName });
      expect(await hide.count()).toBe(1);
      await hide.focus();
      await hide.press("Enter");
      await page.waitForURL((url) => !url.searchParams.has("past"));
      expect(await pastVisible(page)).toBe(false);
      const last = page.getByRole("link", { name: lastPageName });
      expect(await last.count()).toBe(1);
      await last.click();
      await page.waitForURL((url) => url.searchParams.get("page") === "3");
      expect(await keys(page)).toHaveLength(5);
      await page.getByRole("link", { name: firstPageName }).click();
      await page.waitForURL((url) => !url.searchParams.has("page"));
      expect((await keys(page))[0]).toBe("navigation-1");
      expect(journey.requests.some((r) => r.fragment)).toBe(false);
      clean(journey, 4);
    });

    it("native/no-JS: an unavailable search page recovers directly without discarding its scope", async () => {
      const journey = await open(
        twin,
        "/events?q=Navigation&game=Chess&past=1&page=999",
        390,
        false,
      );
      const { page } = journey;
      const first = page.getByRole("link", { name: firstPageName });
      expect(await first.count()).toBe(1);
      await first.focus();
      await first.press("Enter");
      await page.waitForURL((url) => !url.searchParams.has("page"));
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
        q: "Navigation",
        game: "Chess",
        past: "1",
      });
      expect((await keys(page))[0]).toBe("navigation-1");
      expect(await pastVisible(page)).toBe(true);
      clean(journey, 2);
    });

    it("CONTROL: a refused existing Next turn retains the committed screen and supports explicit retry", async () => {
      const journey = await open(twin);
      const { page } = journey;
      const before = await snapshot(page);
      journey.failNext();
      await page.getByTestId("events-pager-next").click();
      await expect.poll(() => page.getByTestId("events-read-retry").isVisible()).toBe(true);
      expect(await snapshot(page)).toEqual(before);
      await page.getByTestId("events-read-retry").click();
      await expect.poll(async () => (await keys(page)).length).toBe(5);
      expect(new URL(page.url()).searchParams.get("page")).toBe("3");
      clean(journey);
    });

    for (const action of ["hide", "last", "recover"] as const) {
      it(`${action}: a failed turn retains committed content/URL/history and retries the same destination`, async () => {
        const journey = await open(
          twin,
          action === "recover" ? "/events?game=Chess&past=1&page=999" : entry,
        );
        const { page } = journey;
        const before = await snapshot(page);
        const name =
          action === "hide" ? hidePastName : action === "last" ? lastPageName : firstPageName;
        const link = page.getByRole("link", { name });
        expect(await link.count()).toBe(1);
        const destination = await link.getAttribute("href");
        journey.failNext();
        await link.click();
        await expect.poll(() => page.getByTestId("events-read-retry").isVisible()).toBe(true);
        expect(await snapshot(page)).toEqual(before);
        await usableFocus(page);
        await page.getByTestId("events-read-retry").click();
        await expect.poll(() => page.url()).toBe(new URL(destination!, GAME_ORIGIN).href);
        const turns = journey.requests.filter((r) => r.fragment);
        expect(turns).toHaveLength(2);
        expect(turns[0]!.path).toBe(turns[1]!.path);
        clean(journey);
      });
    }

    it("a superseded Hide body cannot close the newer committed search preview", async () => {
      const journey = await open(twin);
      const { page } = journey;
      const hide = page.getByRole("link", { name: hidePastName });
      expect(await hide.count()).toBe(1);
      // Hold the consumed body and ignore abort for this single response. This
      // exercises the shipped binder's stale-generation guard, not fetch abort.
      await page.evaluate(`(() => {
        const original = window.fetch.bind(window); let held = false;
        window.fetch = async (url, init) => {
          const target = new URL(typeof url === 'string' ? url : url.url, location.href);
          const delay = !held && !target.searchParams.has('past');
          if (delay) held = true;
          const response = await original(url, delay ? { ...init, signal: undefined } : init);
          if (delay) { const body = await response.text(); Object.defineProperty(response, 'text', { value: () => new Promise(resolve => {
            window.__navigationHeld = true; window.__releaseNavigation = () => { resolve(body); window.__navigationReleased = true; };
          }) }); }
          return response;
        };
      })()`);
      await hide.click();
      await page.waitForFunction("window.__navigationHeld === true");
      await page.getByTestId("events-search").fill("Navigation");
      await page.getByTestId("events-search").press("Enter");
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("Navigation");
      const committed = await snapshot(page);
      await page.evaluate("window.__releaseNavigation()");
      await page.waitForFunction("window.__navigationReleased === true");
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      expect(await snapshot(page)).toEqual(committed);
      expect(await pastVisible(page)).toBe(true);
      expect(await page.getByRole("link", { name: hidePastName }).count()).toBe(0);
      clean(journey);
    });
  });
}
