import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Browser pin for the legacy EventLiveSearchBindingTest: typing in the events
// search box debounces into a settled ?q= read that filters the rendered DOM
// list, and clearing the query restores it. Unit parity lives in
// test/islands-events-live-search.test.ts; this spec proves the same binder
// through the browser against wrangler dev + CI Postgres only. It never
// touches staging or production: local /events reads, no QA token.
const FIXTURE_TITLE = "E2E Community Night";
const MISS_QUERY = "zzz-no-such-event";

function watchConsole(page: Page) {
  const consoleNoise: string[] = [];
  page.on("console", (message) => {
    // Resource-load failures are browser reports, not page logging; the pin
    // is that the binder leaks nothing via console.error/warn.
    if (message.text().startsWith("Failed to load resource")) return;
    if (message.type() === "error" || message.type() === "warning") {
      consoleNoise.push(`${message.type()}: ${message.text()}`);
    }
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
  });
  return {
    async expectQuiet() {
      expect(consoleNoise, "no console errors or warnings").toEqual([]);
      expect(pageErrors, "no uncaught page errors").toEqual([]);
    },
  };
}

test("typing filters the rendered list and clearing the query restores it", async ({ page }) => {
  const console = watchConsole(page);
  await page.goto("/events");
  const search = page.getByTestId("events-search");
  await expect(search).toBeVisible();
  await expect(page.getByTestId("events-list")).toContainText(FIXTURE_TITLE);

  await search.pressSequentially("Community");
  await expect(page).toHaveURL(/\/events\?q=Community/);
  await expect(page.getByTestId("events-list")).toContainText(FIXTURE_TITLE);
  await expect(page.getByTestId("events-search-status")).toContainText("Community");

  await search.fill("");
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByTestId("events-list")).toContainText(FIXTURE_TITLE);
  await expect(page.getByTestId("events-search-status")).toHaveText("");
  await console.expectQuiet();
});

test("a miss swaps in the empty-search block and clearing restores the list", async ({ page }) => {
  const console = watchConsole(page);
  await page.goto("/events");
  const search = page.getByTestId("events-search");
  await expect(search).toBeVisible();
  await expect(page.getByTestId("events-list")).toContainText(FIXTURE_TITLE);

  await search.pressSequentially(MISS_QUERY);
  await expect(page).toHaveURL(new RegExp(`/events\\?q=${MISS_QUERY}`));
  await expect(page.getByTestId("events-list")).toHaveCount(0);
  await expect(page.getByTestId("events-empty-search")).toBeVisible();
  await expect(page.getByTestId("events-search-status")).toContainText(MISS_QUERY);

  await search.fill("");
  await expect(page).toHaveURL(/\/events$/);
  await expect(page.getByTestId("events-empty-search")).toHaveCount(0);
  await expect(page.getByTestId("events-list")).toContainText(FIXTURE_TITLE);
  await console.expectQuiet();
});
