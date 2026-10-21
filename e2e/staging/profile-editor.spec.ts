import type { Page } from "@playwright/test";
import { qaLoginRetryBudgetMs } from "../qa-login-retry.mjs";
import { emptyStorageState, expect, MEMBER_DISCORD_ID, test } from "./fixtures";
import { loginQaMember } from "./qa-login";

// Profiles editor journey: visibility toggles, handle, indexing opt-in,
// accent colour, links and featured games, then the guest public view.
// Failing-first contract for the Builder: red until the editor slice is on
// staging. The guest-view test needs the /u/<handle> slice deployed too —
// merge the editor after the public view or accept red journeys between the
// two landings.
//
// Editor contract pinned here (labels the journey locates):
// - visibility: radio pairs named visibility[<field>] with values
//   public|members (bio, games, timezone, steam, links, featured_games,
//   display_name, avatar, rank, member_since).
// - handle: a control labelled /handle/i holding the current handle.
// - indexing: a checkbox whose label contains "search engines".
// - accent: a control labelled /accent colou?r/i taking #rrggbb.
// - links: "Link 1 label" and "Link 1 URL" (5 rows); featured games:
//   "Featured game 1" (6 rows).
// - saves answer "Profile saved."; refusals reuse the validator messages
//   pinned in test/profile-editor-acceptance.test.ts.
//
// One member login for the file. Every value the journey writes is
// deterministic, so the end state is the cleanup; the handle alternates
// between two values because a change locks for 30 days.

// Fresh member session per file: event pages rotate the bearer on read, so a
// stored token is single-use across files. Member only — one login.
test.beforeAll(async () => {
  test.setTimeout(30_000 + qaLoginRetryBudgetMs(1));
  await loginQaMember();
});

async function save(page: Page): Promise<void> {
  // The real spam trap silently ignores submits within 1000 ms of SSR render.
  await page.waitForTimeout(1100);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/members/${MEMBER_DISCORD_ID}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId("profile-saved")).toHaveText("Profile saved.");
}

// The editor round-trip: every field edited, refused once with its message,
// then saved and re-read after reload. Ends deterministic: bio members-only,
// index opt-in off, accent the profile brand lime.
test("staging QA member edits visibility, accent, links, featured games and indexing", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();

  // Visibility: Bio to Members only, saved and kept across reload.
  const bioMembers = page.locator('input[name="visibility[bio]"][value="members"]');
  await bioMembers.check();
  await save(page);
  await page.reload();
  await expect(page.locator('input[name="visibility[bio]"][value="members"]')).toBeChecked();

  // Accent: a low-contrast colour is refused, the brand lime saves.
  await page.getByLabel(/accent colou?r/i).fill("#1e3a8a");
  await page.waitForTimeout(1100);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Pick an accent colour with stronger contrast on the profile background."),
  ).toBeVisible();
  await page.getByLabel(/accent colou?r/i).fill("#a3ff12");
  await save(page);
  await page.reload();
  await expect(page.getByLabel(/accent colou?r/i)).toHaveValue("#a3ff12");

  // Links: a non-http(s) URL is refused, an https link saves.
  await page.getByLabel("Link 1 label").fill("Blog");
  await page.getByLabel("Link 1 URL").fill("ftp://example.com/blog");
  await page.waitForTimeout(1100);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Links must use http or https.")).toBeVisible();
  await page.getByLabel("Link 1 URL").fill("https://example.com/blog");
  await save(page);
  await page.reload();
  await expect(page.getByLabel("Link 1 URL")).toHaveValue("https://example.com/blog");

  // Featured games persist across reload.
  await page.getByLabel("Featured game 1").fill("Deep Rock Galactic");
  await save(page);
  await page.reload();
  await expect(page.getByLabel("Featured game 1")).toHaveValue("Deep Rock Galactic");

  // Indexing opt-in persists on, then off again (deterministic end state).
  await page.getByLabel(/search engines/i).check();
  await save(page);
  await page.reload();
  await expect(page.getByLabel(/search engines/i)).toBeChecked();
  await page.getByLabel(/search engines/i).uncheck();
  await save(page);
  await page.reload();
  await expect(page.getByLabel(/search engines/i)).not.toBeChecked();
});

// Handle changes lock for 30 days, so the journey cannot assert success every
// run: it attempts the other of two deterministic values and asserts EITHER
// the visible new handle OR the refusal with its next-allowed date. Both
// arms pin behavior; neither passes vacuously.
test("staging QA member changes handle or sees the next-allowed date", async ({ page }) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
  const handleInput = page.getByLabel(/handle/i);
  const current = await handleInput.inputValue();
  const target = current === "qa.member" ? "qa.member.2" : "qa.member";
  await handleInput.fill(target);
  await page.waitForTimeout(1100);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = page.getByTestId("profile-saved");
  const refused = page.getByText(/You can change your handle again on \d{4}-\d{2}-\d{2}\./);
  await expect(saved.or(refused)).toBeVisible();
  if (await refused.isVisible()) {
    const match = (await refused.textContent())?.match(/(\d{4}-\d{2}-\d{2})/);
    const inDays = (new Date(`${match?.[1]}T00:00:00Z`).getTime() - Date.now()) / 86_400_000;
    expect(inDays).toBeGreaterThan(28);
    expect(inDays).toBeLessThan(32);
  } else {
    await expect(handleInput).toHaveValue(target);
  }
});

// The guest public view reflects whatever the editor stored: visibility
// filtering, link rel tokens and the indexing opt-in. Reads the stored
// state from the editor first, so this test stays consistent whatever the
// earlier tests left behind.
test("staging guest sees the QA member public view with visibility applied", async ({
  page,
  browser,
}) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
  const handle = await page.getByLabel(/handle/i).inputValue();
  const bioMembersOnly = await page
    .locator('input[name="visibility[bio]"][value="members"]')
    .isChecked();
  const linkUrl = await page.getByLabel("Link 1 URL").inputValue();
  expect(linkUrl, "editor stores link 1").toMatch(/^https:\/\//);
  const indexOptIn = await page.getByLabel(/search engines/i).isChecked();
  const bio = await page.getByLabel("Bio").inputValue();

  const guest = await browser.newContext({ storageState: emptyStorageState });
  try {
    const guestPage = await guest.newPage();
    const response = await guestPage.goto(`/u/${handle}`);
    expect(response?.status(), "public profile view is deployed").toBe(200);
    await expect(guestPage.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
    if (bioMembersOnly) {
      await expect(guestPage.getByText(bio, { exact: true })).toHaveCount(0);
    } else {
      await expect(guestPage.getByText(bio, { exact: true })).toBeVisible();
    }
    const rel = await guestPage.locator(`a[href="${linkUrl}"]`).getAttribute("rel");
    expect(rel?.split(/\s+/)).toEqual(expect.arrayContaining(["nofollow", "ugc", "noopener"]));
    const robots = await guestPage.locator('meta[name="robots"]').getAttribute("content");
    if (indexOptIn) {
      expect(robots ?? "").not.toMatch(/noindex/);
    } else {
      expect(robots ?? "").toMatch(/noindex/);
    }
  } finally {
    await guest.close();
  }
});
