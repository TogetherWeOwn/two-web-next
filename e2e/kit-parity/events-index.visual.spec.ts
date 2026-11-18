import "./member-board-viewer.visual";
import { expect, test } from "@playwright/test";
import { HONO_ORIGIN, KIT_ORIGIN, PARITY_VIEWPORTS } from "../kit-parity";

const SEEDED_UPCOMING_EVENTS = ["E2E Community Night", "E2E Calendar May", "E2E Calendar June"];

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
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return url.origin === HONO_ORIGIN || url.origin === KIT_ORIGIN
          ? route.continue()
          : route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const response = await page.goto("/events");
      expect(response?.status(), `Kit /events @ ${viewport.name}`).toBe(200);
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
