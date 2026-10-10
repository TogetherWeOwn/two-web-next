import { expect, qaLogin, test } from "./fixtures";

// Moderator activity-log journey against local wrangler dev + disposable
// Postgres: create a draft event through the admin form (which writes one
// activity_log row naming the QA moderator snowflake), then prove the
// read-only viewer renders it (who, what, when, subject) and that an
// unmatched filter renders the empty state. Guest-redirect and member-403
// are unit-pinned in test/admin-activity-log.test.ts and not re-proven here.
// Frozen testids: activity-log-table/activity-log-empty (src/admin/pages.tsx).
test("moderator sees the created event in the activity-log viewer, plus the empty state", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  await qaLogin(context, "qa-moderator");
  const stamp = Date.now();
  const title = `E2E Activity Log ${stamp}`;

  // 1. An action that names a member: create a draft through the admin form.
  // The draft stays a draft, so nothing leaks onto the public calendar; the
  // audit write (created event <title>, causer = QA moderator) is what the
  // viewer must render.
  await page.goto("/admin/events");
  await page.getByRole("link", { name: "New event", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Game", { exact: true }).fill("Minecraft");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Created to prove the activity-log viewer renders.");
  await page.getByLabel("Starts (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 18:00");
  await page.getByLabel("Ends (local wall time, YYYY-MM-DD HH:mm)").fill("2099-03-01 20:00");
  await page.getByLabel("Timezone", { exact: true }).fill("UTC");
  await page.getByLabel("Location", { exact: true }).fill("Community voice");
  await page.getByLabel("Capacity (empty = unlimited)").fill("10");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const eventKey = new URL(page.url()).pathname.split("/").at(-1)!;

  // 2. The viewer renders the row: who, what, when, subject. Filter through
  // the form so the subject-filter wiring is proven too.
  await page.goto("/admin/activity-log");
  await expect(page.getByRole("heading", { name: "Activity log", exact: true })).toBeVisible();
  await page.getByLabel("Subject", { exact: true }).fill(title);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/activity-log\\?.*subject=`));
  const table = page.getByTestId("activity-log-table");
  await expect(table).toBeVisible();
  const row = table.locator("tbody tr", { hasText: title });
  await expect(row).toHaveCount(1);
  // Who: the QA moderator snowflake (src/qa.ts); what: the audit description.
  await expect(row).toContainText("900000000000001397");
  await expect(row).toContainText(`created event ${title}`);
  // When: an ISO time element with a datetime attribute.
  await expect(row.locator("time")).toHaveAttribute("datetime", /.+/);
  // Subject: type plus key of the created draft.
  await expect(row).toContainText("Event");
  await expect(row).toContainText(eventKey);

  // 3. Nothing names a member under an unmatched filter: the filtered empty
  // state, not a crash or a leaked row.
  await page.goto(`/admin/activity-log?subject=${encodeURIComponent(`zz-no-activity-${stamp}`)}`);
  await expect(page.getByTestId("activity-log-empty")).toContainText(
    "No activity matches these filters.",
  );
});
