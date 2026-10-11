import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Activating the skip link navigates to #main, which fires popstate without
// changing the page. The calendar and past-archive islands must not treat that
// as Back/forward: no island read, no reload. Each test first proves the island
// is bound (a real Back to a different address does issue one island read), so
// a zero count on the skip link cannot pass vacuously. Local reads only.
// Island reads are page-script fetches: the calendar tags them x-two-island,
// the archive sends a plain fetch, so count both by resource type.
function countIslandReads(page: Page) {
  let reads = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      request.resourceType() === "fetch" &&
      new URL(request.url()).pathname.startsWith("/events")
    )
      reads += 1;
  });
  return () => reads;
}

async function activateSkipLink(page: Page) {
  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
}

async function backToAnotherAddress(page: Page, withPage: string, without: string) {
  // Two entries so Back lands on an address that differs from the rendered one.
  await page.evaluate(
    `history.pushState(null, "", ${JSON.stringify(withPage)});
     history.pushState(null, "", ${JSON.stringify(without)});
     history.back();`,
  );
}

test("calendar: the skip link issues no island read, a real Back still does", async ({ page }) => {
  const reads = countIslandReads(page);
  await page.goto("/events");
  await expect(page.getByTestId("events-search")).toBeVisible();

  await backToAnotherAddress(page, "/events?q=Community", "/events");
  await expect.poll(reads).toBe(1);
  await expect(page).toHaveURL(/\/events\?q=Community$/);

  await activateSkipLink(page);
  await page.waitForTimeout(500);
  expect(reads(), "skip link must not trigger an island read").toBe(1);
  await expect(page.getByTestId("events-loading")).toBeHidden();
});

test("past archive: the skip link issues no island read, a real Back still does", async ({
  page,
}) => {
  const reads = countIslandReads(page);
  await page.goto("/events/past");
  await expect(page.getByTestId("past-events")).toBeVisible();

  await backToAnotherAddress(page, "/events/past?utm_source=e2e", "/events/past");
  await expect.poll(reads).toBe(1);
  await expect(page).toHaveURL(/\/events\/past\?utm_source=e2e$/);

  await activateSkipLink(page);
  await page.waitForTimeout(500);
  expect(reads(), "skip link must not trigger an island read").toBe(1);
});
