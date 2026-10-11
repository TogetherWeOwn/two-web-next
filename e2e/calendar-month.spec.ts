import { expect, test } from "./fixtures";

// Public calendar-month journey: the CI seed (e2e/seed.mjs) publishes one
// fixture in each of two far-future months, and a real browser drives
// /events?view=calendar&month=<non-default month> as a guest, with no
// session. Proves the chosen month's events render and the other month's do
// not, with the month state asserted before any screenshot/axe step (this
// spec takes neither).
//
// Zero QA logins by design: POST /auth/qa/:identity shares the `qa-login`
// throttle (10/min per runner IP, src/throttle.ts) across the whole
// sequential smoke, and e2e/qa-login-budget.test.mjs fails the suite when
// per-test qaLogin call sites exceed it. Seeded rows live in the disposable
// CI database, so there is nothing to cancel in `finally` (the past.spec.ts
// seeded-row pattern); the local teardown sweep stays waitlist-only.
// Isolation comes from ./fixtures (local-origin route blocking + Worker
// outbound guard): only https://localhost:8787 is ever touched.
test("calendar month view shows the chosen month and hides the other month", async ({ page }) => {
  // The journey: drive the non-default month directly in a real browser. The
  // seeded E2E fixture opens the default month on 2099-01, so 2099-05 is a
  // non-default month.
  await page.goto("/events?view=calendar&month=2099-05");
  await expect(page.getByTestId("calendar-month")).toHaveText("May 2099");
  await expect(page.getByTestId("events-calendar")).toHaveAttribute("data-month", "2099-05");
  const grid = page.getByTestId("events-calendar-grid");
  await expect(grid).toBeVisible();
  // State first: the chosen month renders, the other month does not. No
  // screenshot or axe step runs before these assertions.
  await expect(grid).toContainText("E2E Calendar May");
  await expect(grid).not.toContainText("E2E Calendar June");

  // The month param drives the render in both directions.
  await page.goto("/events?view=calendar&month=2099-06");
  await expect(page.getByTestId("calendar-month")).toHaveText("June 2099");
  await expect(page.getByTestId("events-calendar")).toHaveAttribute("data-month", "2099-06");
  const juneGrid = page.getByTestId("events-calendar-grid");
  await expect(juneGrid).toBeVisible();
  await expect(juneGrid).toContainText("E2E Calendar June");
  await expect(juneGrid).not.toContainText("E2E Calendar May");
});
