import { test, expect, stagingOrigin } from "./fixtures";
import { loginQaMember } from "./qa-login";

// Fresh member session per file: event pages rotate the bearer on read, so a
// stored token is single-use across files. Member only — one login.
test.beforeAll(async () => {
  await loginQaMember();
});

// Staging mirror of the local sign-out journey (e2e/logout.spec.ts) against
// the QA member: the header Sign out form POSTs /logout, which answers 303 to
// /. A form POST that 303-redirects never shows up as a Playwright
// request/response, so this waits for the GET / navigation instead of the
// POST — and never closes the context before that redirect lands, or the
// Worker invocation is canceled and the revoke is lost.
test("staging QA member signs out to guest and the old session cannot replay", async ({
  page,
  context,
}) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();

  // Return home so the captured cookie is the live one: every GET rotates
  // the session, so nothing may load between the capture and the click.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const live = (await context.cookies()).find((item) => item.name === "__Host-two_session");
  expect(live?.value).toBeTruthy();

  await page.getByRole("button", { name: "Sign out" }).click();

  // The 303 lands on / as a guest: join CTA back, no member chrome.
  await expect(page).toHaveURL(`${stagingOrigin}/`);
  await expect(page.getByRole("heading", { name: "The lobby is open." })).toBeVisible();
  await expect(page.getByTestId("join")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByTestId("signin")).toBeVisible();
  expect(
    (await context.cookies()).find((item) => item.name === "__Host-two_session"),
  ).toBeUndefined();

  // The pre-logout cookie cannot replay: the row is revoked, so / serves the
  // guest home and /profile bounces to the OAuth flow instead of the member.
  await context.addCookies([
    {
      name: "__Host-two_session",
      value: live!.value,
      domain: live!.domain,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const home = await context.request.get("/", { maxRedirects: 0 });
  expect(home.status()).toBe(200);
  const homeHtml = await home.text();
  expect(homeHtml).toContain("Join with Discord");
  expect(homeHtml).not.toContain("QA Member");
  const profile = await context.request.get("/profile", { maxRedirects: 0 });
  expect(profile.status()).toBe(302);
  expect(profile.headers()["location"] ?? "").toContain("/auth/discord");
});
