// route-inventory: GET /events
// route-inventory: GET /e/:key
// Unconditional offline Chromium acceptance. Builder consumes unchanged and
// registers the runner in browser CI. No browser-install fallback or skipped cases.
// Breaks caught: native-only failures, stale fragment hrefs, lost live roster
// context, storage-dependent navigation, missing keyboard names or missing anchors.
import { mkdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as access from "../src/admin/store-access";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { linksIn, type ArchiveTwin } from "../test/helpers/past-archive-search-acceptance";
import {
  GRID_PATH,
  LIST_PATH,
  SCHEDULE_NOW,
  SCHEDULE_ORIGIN,
  SCHEDULE_QUERY,
  SCHEDULE_TWINS,
  SELECTED_KEY,
  SELECTED_PATH,
  compileReturnTwins,
  scheduleDetailFixture,
  scheduleFixture,
} from "../test/helpers/schedule-detail-return-acceptance";

let browser: Browser;
let twins: Awaited<ReturnType<typeof compileReturnTwins>>;
const contexts: BrowserContext[] = [];
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  twins = await compileReturnTwins();
});
beforeEach(() => {
  __resetAnonEventCacheForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SCHEDULE_NOW);
  vi.spyOn(access, "recordAccess").mockResolvedValue(true);
});
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  twins?.dispose();
  await browser?.close();
});

async function open(
  twin: ArchiveTwin,
  options: {
    js?: boolean;
    mobile?: boolean;
    member?: boolean;
    bundle?: "source" | "shipped";
  } = {},
) {
  const calendar = scheduleFixture();
  const source = scheduleDetailFixture();
  const context = await browser.newContext({
    javaScriptEnabled: options.js ?? true,
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    timezoneId: "UTC",
    locale: "en-GB",
    serviceWorkers: "block",
  });
  contexts.push(context);
  const reads: { path: string; island: string | undefined; method: string }[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  context.on("page", (page) => page.on("pageerror", (e) => errors.push(e.message)));
  await context.addInitScript(() => {
    for (const name of ["localStorage", "sessionStorage"]) {
      Object.defineProperty(window, name, {
        get() {
          throw new Error("Schedule return must not need browser storage");
        },
      });
    }
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== SCHEDULE_ORIGIN) {
      external.push(url.href);
      return route.abort();
    }
    const island = request.headers()["x-two-island"];
    if (url.pathname === "/events" || url.pathname === SELECTED_PATH) {
      reads.push({ path: url.pathname + url.search, island, method: request.method() });
      const response =
        url.pathname === "/events"
          ? await calendar.render(twin, url.pathname + url.search, island === "events-calendar")
          : await twins.detail(twin, url, source, options.member ? "member" : "guest");
      let body = await response.text();
      if (island === "attendees-live") {
        // Observable marker on transport HTML proves the real binder replaced
        // the roster, not just that the old page already had a refresh link.
        body = body.replace(
          'data-testid="event-attendees"',
          'data-testid="event-attendees" data-fixture-refreshed="1"',
        );
      }
      return route.fulfill({
        status: response.status,
        body,
        contentType: "text/html; charset=utf-8",
      });
    }
    if (url.pathname.startsWith("/islands/")) {
      const name = url.pathname.split("/").at(-1)!;
      // Isolate the two enhancements under test; RSVP writes/count polling,
      // device timezone and sharing are unrelated and never synthesized here.
      const body = ["events-calendar.js", "attendees-live.js"].includes(name)
        ? readFileSync(
            new URL(
              `../${options.bundle === "source" ? "assets" : "public"}/islands/${name}`,
              import.meta.url,
            ),
            "utf8",
          )
        : "";
      return route.fulfill({ body, contentType: "application/javascript" });
    }
    const path = resolve(publicDir, `.${url.pathname}`);
    if (!path.startsWith(resolve(publicDir) + "/")) return route.abort();
    try {
      return await route.fulfill({
        body: readFileSync(path),
        contentType:
          (
            {
              ".css": "text/css",
              ".woff2": "font/woff2",
              ".svg": "image/svg+xml",
              ".png": "image/png",
            } as Record<string, string>
          )[extname(path)] ?? "application/octet-stream",
      });
    } catch {
      return route.abort();
    }
  });
  const page = await context.newPage();
  return { context, page, calendar, reads, errors, external };
}
async function capture(page: Page, name: string) {
  const dir = process.env.SCHEDULE_RETURN_EVIDENCE_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: resolve(dir, `${name}.png`), fullPage: false });
  }
}
async function checkReturn(page: Page, want: Record<string, string>) {
  const back = page
    .getByRole("navigation", { name: "Event calendar", exact: true })
    .getByRole("link");
  expect(await back.count()).toBe(1);
  expect(await back.isVisible()).toBe(true);
  expect(await back.textContent()).toMatch(/back|return|results|schedule|calendar/i);
  const href = await back.getAttribute("href");
  expect(href).toBeTruthy();
  const url = new URL(href!, SCHEDULE_ORIGIN);
  expect(url.origin).toBe(SCHEDULE_ORIGIN);
  expect(url.pathname).toBe("/events");
  expect(Object.fromEntries(url.searchParams)).toEqual(want);
  expect(url.hash).toBe(`#event-${SELECTED_KEY}`);
  return back;
}

describe.each(SCHEDULE_TWINS)("%s real browser schedule return", (twin) => {
  for (const mobile of [false, true]) {
    it.each([false, true])(
      `keyboard/new-tab/reload/native return at ${mobile ? "390x844" : "1280x800"} (JS=%s)`,
      async (js) => {
        const f = await open(twin, { mobile, js });
        await f.page.goto(SCHEDULE_ORIGIN + LIST_PATH);
        const card = f.page.locator(`#event-${SELECTED_KEY} h3 a`);
        expect(await card.count()).toBe(1);
        await capture(
          f.page,
          `${twin}-${mobile ? "mobile" : "desktop"}-${js ? "js" : "native"}-schedule`,
        );
        const href = await card.getAttribute("href");
        expect(href).toBeTruthy();
        await card.focus();
        await f.page.keyboard.press("Enter");
        await f.page.waitForURL((url) => url.pathname === SELECTED_PATH);
        const freshTab = await f.context.newPage();
        await freshTab.goto(new URL(href!, SCHEDULE_ORIGIN).href);
        await freshTab.reload();
        await capture(
          freshTab,
          `${twin}-${mobile ? "mobile" : "desktop"}-${js ? "js" : "native"}-detail`,
        );
        const back = await checkReturn(freshTab, {
          q: SCHEDULE_QUERY,
          game: "Chess",
          past: "1",
          page: "2",
        });
        await back.focus();
        await freshTab.keyboard.press("Enter");
        await freshTab.waitForURL((url) => url.pathname === "/events");
        expect(await freshTab.locator(`#event-${SELECTED_KEY}`).isVisible()).toBe(true);
        expect(new URL(freshTab.url()).hash).toBe(`#event-${SELECTED_KEY}`);
        expect(f.reads.every((r) => r.method === "GET")).toBe(true);
        expect(f.external).toEqual([]);
        expect(f.errors).toEqual([]);
      },
    );
  }

  it.each([false, true])(
    "grid → card/detail → original month is keyboard/native usable (JS=%s)",
    async (js) => {
      const f = await open(twin, { js });
      await f.page.goto(SCHEDULE_ORIGIN + GRID_PATH);
      const selected = f.page.locator('[data-testid="events-calendar-grid"] a');
      const hrefs = await selected.evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLAnchorElement).getAttribute("href")),
      );
      const index = hrefs.findIndex((href) => href?.includes(SELECTED_KEY));
      expect(index).toBeGreaterThanOrEqual(0);
      if (!js) await capture(f.page, `${twin}-desktop-native-grid`);
      await selected.nth(index).focus();
      await f.page.keyboard.press("Enter");
      await f.page.waitForURL(
        (url) => url.pathname === SELECTED_PATH || url.searchParams.has("event"),
      );
      if (new URL(f.page.url()).pathname === "/events") {
        const card = f.page.locator(`#event-${SELECTED_KEY} h3 a`);
        await card.waitFor();
        await card.focus();
        await f.page.keyboard.press("Enter");
        await f.page.waitForURL((url) => url.pathname === SELECTED_PATH);
      }
      const back = await checkReturn(f.page, {
        game: "Chess",
        past: "1",
        view: "calendar",
        month: "2031-01",
      });
      await back.focus();
      await f.page.keyboard.press("Enter");
      await f.page.waitForURL(
        (url) => url.pathname === "/events" && url.searchParams.get("view") === "calendar",
      );
      expect(await f.page.getByTestId("events-calendar-grid").isVisible()).toBe(true);
      expect(await f.page.locator(`#event-${SELECTED_KEY}`).count()).toBe(1);
      expect(f.errors).toEqual([]);
      expect(f.external).toEqual([]);
    },
  );

  it.each(["source", "shipped"] as const)(
    "live attendee replacement preserves schedule and attendee page (%s)",
    async (bundle) => {
      const f = await open(twin, { member: true, bundle });
      const schedule = await (await f.calendar.render(twin, LIST_PATH)).text();
      const link = linksIn(schedule).find((l) => l.url.pathname === SELECTED_PATH);
      expect(link).toBeDefined();
      const url = new URL(link!.url);
      url.searchParams.set("attendees", "2");
      await f.page.goto(url.href);
      expect(await f.page.getByTestId("event-attendees").textContent()).toContain(
        "return-attendee-100",
      );
      await f.page.evaluate(
        (key) =>
          document.dispatchEvent(
            new CustomEvent("going-count-updated", { detail: { eventKey: key } }),
          ),
        SELECTED_KEY,
      );
      await expect
        .poll(async () =>
          f.page.getByTestId("event-attendees").getAttribute("data-fixture-refreshed"),
        )
        .toBe("1");
      const fragment = f.reads.filter((r) => r.island === "attendees-live");
      expect(fragment).toHaveLength(1);
      expect(Object.fromEntries(new URL(fragment[0]!.path, SCHEDULE_ORIGIN).searchParams)).toEqual(
        Object.fromEntries(url.searchParams),
      );
      const refresh = await f.page.getByTestId("event-attendees-refresh").getAttribute("href");
      expect(Object.fromEntries(new URL(refresh!, SCHEDULE_ORIGIN).searchParams)).toEqual(
        Object.fromEntries(url.searchParams),
      );
      await checkReturn(f.page, { q: SCHEDULE_QUERY, game: "Chess", past: "1", page: "2" });
      expect(f.external).toEqual([]);
      expect(f.errors).toEqual([]);
    },
  );

  it.each(["source", "shipped"] as const)(
    "calendar fragment commits install fresh context-bearing entry links (%s)",
    async (bundle) => {
      const f = await open(twin, { bundle });
      await f.page.goto(SCHEDULE_ORIGIN + "/events?game=Chess");
      await f.page.getByTestId("events-search").fill(SCHEDULE_QUERY);
      await f.page.getByRole("button", { name: "Search", exact: true }).click();
      await expect
        .poll(async () => new URL(f.page.url()).searchParams.get("q"))
        .toBe(SCHEDULE_QUERY);
      await f.page.getByTestId("events-pager-next").click();
      await expect.poll(async () => new URL(f.page.url()).searchParams.get("page")).toBe("2");
      const href = await f.page.locator(`#event-${SELECTED_KEY} h3 a`).getAttribute("href");
      expect(href).toBeTruthy();
      expect(f.reads.some((r) => r.island === "events-calendar")).toBe(true);
      const tab = await f.context.newPage();
      await tab.goto(new URL(href!, SCHEDULE_ORIGIN).href);
      await checkReturn(tab, { q: SCHEDULE_QUERY, game: "Chess", page: "2" });
      expect(f.errors).toEqual([]);
      expect(f.external).toEqual([]);
    },
  );
});
