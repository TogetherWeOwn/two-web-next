import { test, expect, qaLogin } from "./fixtures";

// One member login covers the edit and sign-out journeys: POST
// /auth/qa/:identity shares the `qa-login` throttle (10/min per runner IP,
// src/throttle.ts) across the whole sequential smoke, so each spec file spends
// as few logins as it can. The moderator admin-link journey rides the
// activity-log spec's moderator session instead of a second login here.
test("QA member edits and persists their profile, then signs out", async ({ page, context }) => {
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
  await expect(
    page.getByRole("button", { name: "Use this device's timezone", exact: true }),
  ).toBeFocused();
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
