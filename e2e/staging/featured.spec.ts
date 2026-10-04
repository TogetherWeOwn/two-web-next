import { cleanupFeaturedFixture, homeHasHeadline } from "./featured-checks";
import { emptyStorageState, expect, moderatorStorageState, stagingOrigin, test } from "./fixtures";
import { loginQaModerator } from "./qa-login";

test.use({ storageState: moderatorStorageState });

// Fresh moderator session per file: admin page views rotate the bearer, so a
// stored token is single-use across files. Moderator only — one login.
test.beforeAll(async () => {
  await loginQaModerator();
});

// Highest position the form accepts is 2147483647 (src/admin/validation.ts).
// A slot this far down sorts after every real card, so a run that dies before
// cleanup still never displaces the community team's own content.
const LAST_POSITION = "2147483000";

// The window bounds are UTC wall text, `YYYY-MM-DD HH:mm`. The start sits an
// hour in the past so clock skew between the runner and the Worker cannot
// hide the slot; the end is a day out so the run never races the cutoff.
function utcWall(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 16).replace("T", " ");
}

// The homepage bounds its featured read to 500 ms and degrades to no section,
// so poll rather than trust a single load. Transport/non-200 failures retry too.
const HOME_POLL = { timeout: 20_000, intervals: [1_000, 2_000, 3_000] };

// Moderator owns the journey: a published slot is created, shown to a guest on
// the homepage, renamed, then deleted through the UI. The fixture is deleted
// in `finally` by id; an unsuccessful cleanup annotates the original red run.
// Featured content touches no queue and no Discord write-back.
test("staging moderator creates, edits and deletes a featured slot shown on the homepage", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const title = `Staging E2E Featured ${stamp}`;
  const renamed = `Staging E2E Featured Renamed ${stamp}`;
  const body = "Created by the post-deploy staging suite; deleted before the run ends.";
  let id: string | undefined;
  let deleted = false;
  // Explicitly empty: a bare newContext() inherits this file's moderator
  // storageState from the staging config, which would show moderator
  // sessions instead of the public page and rotate (kill) the stored bearer.
  const guestContext = await browser.newContext({ storageState: emptyStorageState });
  try {
    const guest = await guestContext.newPage();

    // 1. Create: published, visible now, no image (no FEATURED_IMAGE_HOSTS
    // dependency), last in order.
    await page.goto("/admin/featured");
    await page.getByTestId("new-featured").click();
    await page.getByLabel("Headline", { exact: true }).fill(title);
    await page.getByLabel("Body", { exact: true }).fill(body);
    await page.getByLabel("Published", { exact: true }).check();
    await page.getByLabel("Position (lower appears first)", { exact: true }).fill(LAST_POSITION);
    await page
      .getByLabel("Show from (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)", { exact: true })
      .fill(utcWall(-3_600_000));
    await page
      .getByLabel("Show until (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)", { exact: true })
      .fill(utcWall(86_400_000));
    await page.getByTestId("save-featured").click();
    await expect(page).toHaveURL(/\/admin\/featured\/[1-9]\d*$/);
    id = new URL(page.url()).pathname.split("/").at(-1);
    expect(id).toBeDefined();
    await expect(page.getByRole("heading", { name: `Edit ${title}`, exact: true })).toBeVisible();
    await expect(page.getByTestId("featured-preview").getByTestId("featured-item")).toContainText(
      title,
    );

    // 2. A guest sees the slot in the homepage featured section.
    await expect.poll(() => homeHasHeadline(guest, title, true), HOME_POLL).toBe(true);
    await expect(guest.getByRole("heading", { name: "From the community team" })).toBeVisible();
    const shown = guest
      .getByTestId("featured-content")
      .getByTestId("featured-item")
      .filter({ has: guest.getByRole("heading", { level: 3, name: title, exact: true }) });
    await expect(shown).toHaveCount(1);
    await expect(shown).toContainText(body);

    // 3. Edit the headline; the guest sees the new one and not the old one.
    await page.getByLabel("Headline", { exact: true }).fill(renamed);
    await page.getByTestId("save-featured").click();
    await expect(page.getByRole("heading", { name: `Edit ${renamed}`, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/admin/featured/${id}$`));
    await expect.poll(() => homeHasHeadline(guest, renamed, true), HOME_POLL).toBe(true);
    // Same load that showed the new headline, so this absence is not a read
    // that degraded to an empty section.
    await expect(guest.getByRole("heading", { level: 3, name: title, exact: true })).toHaveCount(0);

    // 4. Delete through the UI; the homepage drops it and the edit page 404s.
    // The 404 is the firm proof: a homepage read that degrades to no section
    // would also pass the absence poll.
    await page.getByTestId("delete-featured").click();
    await expect(page).toHaveURL(/\/admin\/featured$/);
    deleted = true;
    await expect(page.getByRole("link", { name: renamed, exact: true })).toHaveCount(0);
    await expect.poll(() => homeHasHeadline(guest, renamed, false), HOME_POLL).toBe(true);
    const gone = await page.goto(`/admin/featured/${id}`);
    expect(gone?.status()).toBe(404);
  } finally {
    try {
      if (id !== undefined && !deleted) {
        await cleanupFeaturedFixture(page.request, id, stagingOrigin, testInfo);
      }
    } finally {
      await guestContext.close();
    }
  }
});
