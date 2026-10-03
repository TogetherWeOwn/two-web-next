import { test, expect } from "./fixtures";
import { emptyStorageState } from "./fixtures";

// Public journey: no session needed. Runs explicitly unauthenticated so a
// bare newContext() here does not inherit the member storageState from the
// staging config.
test.use({ storageState: emptyStorageState });

// GET-only archive smoke: list/empty, the page-two turn, and the out-of-range
// refusal. Frozen testids in src/islands/contracts.ts. Page navigations only:
// no fixtures, no writes, no session.
test("staging past archive renders the list or the empty state", async ({ page }) => {
  const response = await page.goto("/events/past");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("past-events")).toBeVisible();
  await expect(
    page
      .getByTestId("past-events-list")
      .or(page.getByTestId("past-events-empty"))
      .or(page.getByTestId("past-events-out-of-range")),
  ).toBeVisible();
});

test("staging past archive page two advances or stays valid", async ({ page }) => {
  const response = await page.goto("/events/past?page=2");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("past-events")).toBeVisible();
  await expect(
    page
      .getByTestId("past-events-list")
      .or(page.getByTestId("past-events-empty"))
      .or(page.getByTestId("past-events-out-of-range")),
  ).toBeVisible();
});

test("staging past archive out-of-range page renders without error", async ({ page }) => {
  const response = await page.goto("/events/past?page=9999");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("past-events")).toBeVisible();
  // Far past the last page there are never rows: either the out-of-range
  // refusal (non-empty archive) or the first-visit empty state (empty archive).
  await expect(
    page.getByTestId("past-events-out-of-range").or(page.getByTestId("past-events-empty")),
  ).toBeVisible();
});
