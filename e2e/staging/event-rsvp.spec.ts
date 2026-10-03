import { test, expect } from "./fixtures";
import { memberStorageState, moderatorStorageState } from "./fixtures";
import { loginQaIdentities } from "./qa-login";

// Fresh sessions per file: event pages rotate the bearer on read, so a stored
// token is single-use across files. Member + moderator: two logins — the
// journey needs both identities.
test.beforeAll(async () => {
  await loginQaIdentities();
});

// Moderator owns the journey: a draft is created, published for the RSVP, and
// cancelled in `finally` so the fixture never lingers. Publishing and RSVP
// writes enqueue sync-event carriers (src/events/sync.ts), but with no
// SYNC_EVENT_QUEUE consumer pointed at the live guild there is no Discord
// write-back; the cancelled fixture doubles as the 410 case.
test("staging member RSVPs going on a fixture, then withdraws", async ({ browser }) => {
  const moderator = await browser.newContext({ storageState: moderatorStorageState });
  const member = await browser.newContext({ storageState: memberStorageState });
  let eventKey: string | undefined;
  try {
    const admin = await moderator.newPage();
    await admin.goto("/admin/events");
    await admin.getByRole("link", { name: "New event", exact: true }).click();
    const stem = `Staging E2E RSVP ${Date.now()}`;
    await admin.getByLabel("Title", { exact: true }).fill(stem);
    await admin.getByLabel("Game", { exact: true }).fill("Minecraft");
    await admin
      .getByLabel("Description", { exact: true })
      .fill("Created by the post-deploy staging suite; cancelled after the run.");
    await admin.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 18:00");
    await admin.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 20:00");
    await admin.getByLabel("Timezone", { exact: true }).fill("UTC");
    await admin.getByLabel("Location", { exact: true }).fill("Staging lounge");
    await admin.getByLabel("Capacity (empty = unlimited)").fill("10");
    await admin.getByRole("button", { name: "Create draft", exact: true }).click();
    await expect(admin).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
    eventKey = new URL(admin.url()).pathname.split("/").at(-1);
    expect(eventKey).toBeDefined();
    await expect(admin.getByRole("heading", { name: "Status: draft", exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      admin.getByRole("heading", { name: "Status: published", exact: true }),
    ).toBeVisible();

    const page = await member.newPage();
    await page.goto(`/e/${eventKey}`);
    await expect(page.getByRole("heading", { name: stem, exact: true })).toBeVisible();
    await expect(page.getByTestId("rsvp-going")).toBeVisible();
    const going = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/events/${eventKey}/rsvp`) &&
        response.request().method() === "PUT",
    );
    await page.getByTestId("rsvp-going").click();
    expect((await going).status()).toBe(201);
    await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
    await page.reload();
    await expect(page.getByTestId("rsvp-confirmed")).toContainText("You're in");
    const withdrawn = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/events/${eventKey}/rsvp`) &&
        response.request().method() === "DELETE",
    );
    await page.getByTestId("rsvp-withdraw").click();
    expect((await withdrawn).status()).toBe(204);
    await expect(page.getByTestId("rsvp-going")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("rsvp-going")).toBeVisible();
    await expect(page.getByTestId("rsvp-confirmed")).toHaveCount(0);
  } finally {
    if (eventKey) {
      const admin = await moderator.newPage();
      await admin.goto(`/admin/events/${eventKey}`);
      const cancel = admin.getByTestId("cancel-event");
      if (await cancel.isVisible()) {
        await cancel.click();
        await expect(
          admin.getByRole("heading", { name: "Status: cancelled", exact: true }),
        ).toBeVisible();
      }
      await admin.close();
    }
    await member.close();
    await moderator.close();
  }
});
