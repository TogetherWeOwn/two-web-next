import { expect, test } from "./fixtures";

// Public journey: no session needed. The local browser-smoke run is
// unauthenticated by default, so no storageState override is required here
// (unlike the staging config, which inherits a member storageState).
// Deterministic archive smoke against the seeded local state: exactly one
// archived row ("E2E Past Night" in e2e/seed.mjs, page size 20, so
// totalPages = 1). Page 1 must render the list with that row; pages 2 and
// 9999 must render the out-of-range refusal. Unlike the staging spec, which
// tolerates an unknown live archive, these assertions fail if the archive
// wrongly renders empty. Frozen testids in src/islands/contracts.ts. Page
// navigations only: no fixtures, no writes, no session beyond the seeded
// past-aged row in e2e/seed.mjs.
test("past archive renders the seeded row on page one", async ({ page }) => {
  const response = await page.goto("/events/past");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("past-events")).toBeVisible();
  // The list node is always rendered (hidden when empty) as the island
  // fragment-swap target, so assert per-state rather than with .or().
  await expect(page.getByTestId("past-events-list")).toBeVisible();
  await expect(page.getByTestId("past-events-list")).toContainText("E2E Past Night");
  await expect(page.getByTestId("past-events-empty")).toHaveCount(0);
  await expect(page.getByTestId("past-events-out-of-range")).toHaveCount(0);
});

test("past archive page two renders the out-of-range refusal", async ({ page }) => {
  const response = await page.goto("/events/past?page=2");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("past-events")).toBeVisible();
  await expect(page.getByTestId("past-events-out-of-range")).toBeVisible();
  await expect(page.getByTestId("past-events-out-of-range")).toContainText(
    "Page 2 is outside the archive. There is 1 page.",
  );
  await expect(page.getByTestId("past-events-list")).toBeHidden();
  await expect(page.getByTestId("past-events-empty")).toHaveCount(0);
});

test("past archive out-of-range page renders without error", async ({ page }) => {
  const response = await page.goto("/events/past?page=9999");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("past-events")).toBeVisible();
  await expect(page.getByTestId("past-events-out-of-range")).toBeVisible();
  await expect(page.getByTestId("past-events-out-of-range")).toContainText(
    "Page 9999 is outside the archive. There is 1 page.",
  );
  await expect(page.getByTestId("past-events-list")).toBeHidden();
});
