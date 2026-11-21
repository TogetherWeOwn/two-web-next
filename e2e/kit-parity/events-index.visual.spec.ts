import "./member-board-viewer.visual";
import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { HONO_ORIGIN, KIT_ORIGIN, PARITY_VIEWPORTS } from "../kit-parity";

const SEEDED_UPCOMING_EVENTS = ["E2E Community Night", "E2E Calendar May", "E2E Calendar June"];

async function blockExternalRequests(context: BrowserContext) {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === HONO_ORIGIN || url.origin === KIT_ORIGIN
      ? route.continue()
      : route.abort("blockedbyclient");
  });
}

async function gotoKitEvents(page: Page, path: string) {
  const url = `${KIT_ORIGIN}${path}`;
  const response = await page.goto(url);
  if (!response) throw new Error(`No document response for ${path}`);
  expect(response.url()).toBe(url);
  expect(response.status(), `Kit ${path}`).toBe(200);
  expect(response.headers()["x-two-renderer"], `renderer for ${path}`).toBe("kit");
  return response;
}

async function attachReviewScreenshot(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await test.info().attach(name, { path, contentType: "image/png" });
}

// Capture before the mutable browser and parity journeys run. The seeded
// event inventory and RSVP count are asserted so leaked fixtures cannot become
// part of the visual baseline unnoticed.
test("Kit events index renders the seeded guest schedule @ desktop and mobile", async ({
  browser,
}) => {
  for (const viewport of PARITY_VIEWPORTS) {
    const context = await browser.newContext({
      baseURL: KIT_ORIGIN,
      viewport: viewport.size,
    });
    const pageErrors: string[] = [];
    try {
      await blockExternalRequests(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const css = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/kit-events-schedule.css",
      );
      await gotoKitEvents(page, "/events");
      expect((await css).ok()).toBe(true);
      await expect(page.getByRole("main")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("What's on. Say you're in.");
      await expect(page.getByRole("contentinfo")).toContainText("Together We Own");
      await expect(page.locator(".schedule-day")).not.toHaveCount(0);
      await expect(page.getByTestId("events-calendar")).toBeVisible();
      await expect(page.getByTestId("event-card")).toHaveCount(SEEDED_UPCOMING_EVENTS.length);
      for (const title of SEEDED_UPCOMING_EVENTS) {
        const row = page.getByTestId("event-card").filter({ hasText: title });
        await expect(row, `seeded event ${title}`).toHaveCount(1);
        await expect(row).toBeVisible();
      }
      await expect(
        page.getByTestId("event-card").filter({ hasText: "E2E Community Night" }),
      ).toContainText("0 of 10 going");
      await page.waitForLoadState("networkidle");
      const documentWidth = await page.locator("html").evaluate((element) => element.scrollWidth);
      expect(documentWidth, `no horizontal overflow @ ${viewport.name}`).toBeLessThanOrEqual(
        viewport.size.width,
      );
      await attachReviewScreenshot(page, `kit-review-calendar-schedule-${viewport.size.width}`);
      await expect.soft(page).toHaveScreenshot(`kit-events-index-${viewport.name}.png`, {
        fullPage: true,
        mask: [page.locator("time")],
      });
      expect(pageErrors, `no uncaught page errors @ ${viewport.name}`).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

for (const viewport of [...PARITY_VIEWPORTS.map(({ size }) => size), { width: 320, height: 844 }]) {
  test(`Kit calendar review states @ ${viewport.width}px`, async ({ context, page }) => {
    await blockExternalRequests(context);
    await page.setViewportSize(viewport);
    const failed = await context.newPage();
    await failed.setViewportSize(viewport);

    // Search bypasses the anonymous HTML cache. Both requests must reach the
    // fixture's Discord read before either is allowed to render its result.
    const pair = { "x-e2e-discord-read-pair": randomUUID() };
    await page.setExtraHTTPHeaders(pair);
    await failed.setExtraHTTPHeaders({ ...pair, "x-e2e-discord-read": "failed" });
    const search = "/events?q=e2e-no-matching-event-7319";
    const responses = await Promise.all([
      gotoKitEvents(failed, search),
      gotoKitEvents(page, search),
    ]);
    for (const response of responses) {
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(response.headers()["x-e2e-discord-read-overlapped"]).toBe("true");
    }
    await page.setExtraHTTPHeaders({});
    await failed.setExtraHTTPHeaders({ "x-e2e-discord-read": "failed" });
    await expect(page.getByTestId("events-empty-search")).toBeVisible();
    await expect(page.getByTestId("events-empty-error")).toHaveCount(0);
    await expect(failed.getByTestId("events-empty-error")).toBeVisible();
    await expect(failed.getByTestId("events-empty-search")).toHaveCount(0);
    await attachReviewScreenshot(page, `kit-review-calendar-search-miss-${viewport.width}`);
    await attachReviewScreenshot(failed, `kit-review-calendar-error-${viewport.width}`);

    const month = "/events?view=calendar&month=2099-05";
    // The month view is cacheable, so reserve a distinct key for the failed read.
    await gotoKitEvents(failed, `${month}&e2e-recovery=partial`);
    await expect(failed.getByTestId("events-partial-source")).toBeVisible();
    await expect(failed.getByTestId("events-calendar-grid")).toContainText("E2E Calendar May");
    await attachReviewScreenshot(failed, `kit-review-calendar-partial-${viewport.width}`);

    await gotoKitEvents(page, month);
    await expect(page.getByTestId("events-partial-source")).toHaveCount(0);
    await expect(page.getByTestId("calendar-month")).toHaveText("May 2099");
    const grid = page.getByTestId("events-calendar-grid");
    await expect(grid).toBeVisible();
    await expect(grid).toContainText("E2E Calendar May");
    await expect(grid).not.toContainText("E2E Calendar June");
    const scroll = page.getByTestId("events-calendar-scroll");
    for (const position of ["start", "end"] as const) {
      const target = await scroll.evaluate((element, end) => {
        const left = end ? element.scrollWidth - element.clientWidth : 0;
        element.scrollTo({ left, behavior: "instant" });
        return left;
      }, position === "end");
      await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBe(target);
      await attachReviewScreenshot(page, `kit-review-calendar-grid-${viewport.width}-${position}`);
    }
  });
}

test("Kit events fragment retains switchable regions without the Ember document", async ({
  request,
}) => {
  const path = "/events?view=calendar&month=2099-05";
  const response = await request.get(`${KIT_ORIGIN}${path}`, {
    headers: { "x-two-island": "events-calendar" },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["x-two-renderer"]).toBe("kit");
  const html = await response.text();
  expect(html).toContain('rel="canonical"');
  expect(html).toContain(`/auth/discord?next=${encodeURIComponent(path)}`);
  for (const region of ["head", "subscribe", "actions", "miss", "content"]) {
    expect(html).toContain(`data-cal-zone="${region}"`);
  }
  expect(html).not.toMatch(/<!doctype|<main\b|<footer\b|<script\b/i);
});
