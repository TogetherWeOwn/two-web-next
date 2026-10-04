import { test, expect, qaLogin } from "./fixtures";

test("QA member edits and persists their profile using the keyboard", async ({ page, context }) => {
  await qaLogin(context, "qa-member");
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
  // The real spam trap silently ignores submits within 1000 ms of SSR render.
  await page.waitForTimeout(1100);
  await page.getByLabel("Bio", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Keyboard smoke: community game nights.");
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
  await expect(
    view.getByText("Keyboard smoke: community game nights.", { exact: true }),
  ).toBeVisible();
  await expect(view.getByText("Timezone: Europe/London", { exact: true })).toBeVisible();
  await expect(view.getByRole("listitem")).toHaveText(["Deep Rock Galactic", "Minecraft"]);
});

test("QA member signs out from the profile header and sees no moderator shortcut", async ({
  page,
  context,
}) => {
  await qaLogin(context, "qa-member");
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
  await expect(page.getByTestId("profile-admin-link")).toHaveCount(0);
  const logoutRequest = page.waitForRequest(
    (request) => request.url().endsWith("/logout") && request.method() === "POST",
  );
  await page.getByTestId("profile-signout").getByRole("button", { name: "Sign out" }).click();
  await logoutRequest;
  // The 303 lands on / as a guest; the cookie is cleared.
  await expect(page.getByTestId("signin")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  expect(
    (await context.cookies()).find((item) => item.name === "__Host-two_session"),
  ).toBeUndefined();
});

test("QA moderator reaches the admin panel from the profile header", async ({ page, context }) => {
  await qaLogin(context, "qa-moderator");
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Moderator", exact: true })).toBeVisible();
  await page.getByTestId("profile-admin-link").click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Moderation", exact: true })).toBeVisible();
});
