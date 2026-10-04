import { test, expect } from "./fixtures";
import { emptyStorageState } from "./fixtures";

// Public journey: no session needed. Runs explicitly unauthenticated so the
// rotating session reader on /events cannot consume (kill) the shared member
// bearer that profile/auth specs reuse, and a bare newContext() here would
// inherit the member storageState from the staging config.
test.use({ storageState: emptyStorageState });

// Runs in chromium, mobile-375 and reduced-motion: list, search miss + clear,
// and the calendar month step. Frozen testids in src/islands/contracts.ts.
test("staging events list searches, clears and steps the calendar month", async ({ page }) => {
  await page.goto("/events");
  await expect(page.getByTestId("events-content")).toBeVisible();
  await expect(
    page.getByTestId("events-list").or(page.getByTestId("events-empty-never")),
  ).toBeVisible();

  const miss = `staging-miss-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  await page.getByTestId("events-search").fill(miss);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  // Staging flake: when a slow episode pushes the Discord read past its 1s
  // deadline, the search renders the error state instead of the miss block
  // (error beats search-miss by contract). Retry once through the Retry link;
  // a persistent breakage still fails on the second attempt below.
  const missBlock = page.getByTestId("events-empty-search");
  const errorBlock = page.getByTestId("events-empty-error");
  await expect(missBlock.or(errorBlock)).toBeVisible();
  if (await errorBlock.isVisible()) {
    await page.getByTestId("events-retry").click();
  }
  await expect(missBlock).toBeVisible();
  await expect(page.getByTestId("events-empty-search")).toContainText(
    "Nothing matches that search.",
  );
  await page.getByTestId("events-search-clear-empty").click();
  await expect(page.getByTestId("events-empty-search")).toHaveCount(0);

  await page.getByTestId("events-view-calendar").click();
  const month = page.getByTestId("calendar-month");
  await expect(month).toBeVisible();
  const before = await month.textContent();
  await page.getByRole("link", { name: "Next month", exact: true }).click();
  await expect(month).not.toHaveText(before ?? "");
  const after = await month.textContent();
  await page.getByRole("link", { name: "Previous month", exact: true }).click();
  await expect(month).not.toHaveText(after ?? "");
  await expect(month).toHaveText(before ?? "");
});
