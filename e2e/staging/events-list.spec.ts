import { test, expect } from "./fixtures";
import { emptyStorageState } from "./fixtures";
import {
  SEARCH_ATTEMPT_SETTLE_MS,
  SEARCH_RETRY_BACKOFF_MS,
  searchRetryBudgetMs,
  searchStillErroredError,
} from "../search-retry.mjs";

// Public journey: no session needed. Runs explicitly unauthenticated so the
// rotating session reader on /events cannot consume (kill) the shared member
// bearer that profile/auth specs reuse, and a bare newContext() here would
// inherit the member storageState from the staging config.
test.use({ storageState: emptyStorageState });

// Runs in chromium, mobile-375 and reduced-motion: list, search miss + clear,
// and the calendar month step. Frozen testids in src/islands/contracts.ts.
test("staging events list searches, clears and steps the calendar month", async ({ page }) => {
  // The config's 30s covers the journey itself; the bounded search retries get their own budget.
  test.setTimeout(30_000 + searchRetryBudgetMs());
  await page.goto("/events");
  await expect(page.getByTestId("events-content")).toBeVisible();
  await expect(
    page.getByTestId("events-list").or(page.getByTestId("events-empty-never")),
  ).toBeVisible();

  const miss = `staging-miss-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  await page.getByTestId("events-search").fill(miss);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  // Staging flake: when the Discord read fails (1s deadline) the search renders
  // the error state instead of the miss block (error beats search-miss by
  // contract, so the product stays as is). Retry through the Retry link with
  // growing pauses until the miss block shows. An error that outlasts the whole
  // bounded schedule is a dark collector and fails with a named cause.
  const missBlock = page.getByTestId("events-empty-search");
  const errorBlock = page.getByTestId("events-empty-error");
  const searchStartedAt = Date.now();
  let retries = 0;
  for (;;) {
    await expect(missBlock.or(errorBlock)).toBeVisible({ timeout: SEARCH_ATTEMPT_SETTLE_MS });
    if (await missBlock.isVisible()) break;
    const pauseMs = SEARCH_RETRY_BACKOFF_MS[retries];
    if (pauseMs === undefined) {
      throw searchStillErroredError(retries + 1, Date.now() - searchStartedAt);
    }
    await page.waitForTimeout(pauseMs);
    retries += 1;
    // The island hides the content zone while the retry is in flight, so the
    // stale error block is not visible again until the fetched page patches in.
    await page.getByTestId("events-retry").click();
  }
  // Surfaces in the report how often the tolerance was needed.
  test.info().annotations.push({ type: "search-retries", description: String(retries) });
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
