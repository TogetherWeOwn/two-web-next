import { test, expect } from "./fixtures";
import { loginQaMember } from "./qa-login";

// Fresh member session per file: event pages rotate the bearer on read, so a
// stored token is single-use across files. Member only — one login.
test.beforeAll(async () => {
  await loginQaMember();
});

// CI keyboard flow verbatim, against the staging QA member: 1100 ms spam
// floor, Tab order Bio to Games to Timezone to Save, Enter submits.
test("staging QA member edits and persists their profile using the keyboard", async ({ page }) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
  // The real spam trap silently ignores submits within 1000 ms of SSR render.
  await page.waitForTimeout(1100);
  const bio = `Staging run ${Date.now()}: community game nights.`;
  await page.getByLabel("Bio").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(bio);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Games (one per line)")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Deep Rock Galactic\nMinecraft");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Timezone", { exact: true })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Europe/London");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeFocused();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/members/900000000000001396") &&
      response.request().method() === "PATCH",
  );
  await page.keyboard.press("Enter");
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId("profile-saved")).toHaveText("Profile saved.");
  await expect(page.getByTestId("profile-saved")).toBeFocused();
  await page.reload();
  const view = page.getByTestId("profile-view");
  await expect(view.getByText(bio, { exact: true })).toBeVisible();
  await expect(view.getByText("Timezone: Europe/London", { exact: true })).toBeVisible();
  await expect(view.getByRole("listitem")).toHaveText(["Deep Rock Galactic", "Minecraft"]);
});

// Read-only: the profile shell carries Sign out for every
// member and no moderator shortcut for a non-moderator. Never clicks Sign out
// here, which would revoke the stored session the other specs rely on.
test("staging QA member sees Sign out and no moderator shortcut on their profile", async ({
  page,
}) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
  await expect(
    page.getByTestId("profile-signout").getByRole("button", { name: "Sign out" }),
  ).toBeVisible();
  await expect(page.getByTestId("profile-admin-link")).toHaveCount(0);
});
