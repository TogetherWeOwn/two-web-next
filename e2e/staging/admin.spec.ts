import { test, expect } from "./fixtures";
import { emptyStorageState, moderatorStorageState } from "./fixtures";
import { loginQaModerator } from "./qa-login";

test.use({ storageState: moderatorStorageState });

// Fresh moderator session per file: event pages rotate the bearer on read,
// so a stored token is single-use across files. Moderator only — one login.
test.beforeAll(async () => {
  await loginQaModerator();
});

// Moderator staging journey. This spec NEVER publishes: the fixture is
// cancelled from draft, so no sync-event carrier is enqueued (only
// published/cancelled statuses enqueue, per src/events/sync.ts). The guest
// sees 403 on the draft, 410 after cancellation.
test("staging moderator creates a draft then cancels it without publishing", async ({
  page,
  browser,
}) => {
  let eventKey: string | undefined;
  // Explicitly empty: a bare newContext() inherits this file's moderator
  // storageState from the staging config, which would both void the 403
  // expectation and rotate (kill) the stored moderator bearer.
  const guest = await browser.newContext({ storageState: emptyStorageState });
  try {
    await page.goto("/admin/events");
    await page.getByRole("link", { name: "New event", exact: true }).click();
    const stem = `Staging E2E Draft ${Date.now()}`;
    await page.getByLabel("Title", { exact: true }).fill(stem);
    await page.getByLabel("Game", { exact: true }).fill("Tabletop");
    await page
      .getByLabel("Description", { exact: true })
      .fill("Created by the post-deploy staging suite; cancelled, never published.");
    await page.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-04-01 18:00");
    await page.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-04-01 20:00");
    await page.getByLabel("Timezone", { exact: true }).fill("UTC");
    await page.getByLabel("Location", { exact: true }).fill("Staging lounge");
    await page.getByLabel("Capacity (empty = unlimited)").fill("");
    await page.getByRole("button", { name: "Create draft", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
    eventKey = new URL(page.url()).pathname.split("/").at(-1);
    expect(eventKey).toBeDefined();
    await expect(page.getByRole("heading", { name: "Status: draft", exact: true })).toBeVisible();

    const draft = await guest.request.get(`/e/${eventKey}`, { maxRedirects: 0 });
    expect(draft.status()).toBe(403);

    await page.getByTestId("cancel-event").click();
    await expect(
      page.getByRole("heading", { name: "Status: cancelled", exact: true }),
    ).toBeVisible();
    const cancelled = await guest.request.get(`/e/${eventKey}`, { maxRedirects: 0 });
    expect(cancelled.status()).toBe(410);
  } finally {
    if (eventKey) {
      await page.goto(`/admin/events/${eventKey}`);
      const cancel = page.getByTestId("cancel-event");
      if (await cancel.isVisible()) {
        await cancel.click();
        await expect(
          page.getByRole("heading", { name: "Status: cancelled", exact: true }),
        ).toBeVisible();
      }
    }
    await guest.close();
  }
});

// Read-only: a moderator's profile shell links to /admin,
// and the link lands on the guarded dashboard.
test("staging moderator reaches the admin panel from their profile header", async ({ page }) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Moderator", exact: true })).toBeVisible();
  await page.getByTestId("profile-admin-link").click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Moderation", exact: true })).toBeVisible();
});
