import { test, expect, localOrigin } from "./fixtures";

// Sign-out journey: the stubbed OAuth join from join.spec.ts, then the header
// Sign out form POSTs /logout. The server answers 303 to / with the session
// cookie cleared and the row revoked, so the landing page is the guest home
// and the old cookie cannot replay into /profile.
test("sign out answers 303 to / as guest and the old session cannot replay", async ({
  page,
  context,
}) => {
  let authorizations = 0;
  await context.route(`${localOrigin}/auth/discord`, async (route) => {
    // Same stub as join.spec.ts: keep the production state cookies, replace
    // the Discord authorize hop with the local callback. No Discord request.
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(302);
    authorizations++;
    const url = new URL(response.headers().location!);
    expect(url.origin).toBe("https://discord.com");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        location: `${localOrigin}/auth/discord/callback?code=e2e-code&state=${encodeURIComponent(state!)}`,
      },
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The lobby is open." })).toBeVisible();
  await page.getByTestId("join").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(authorizations).toBe(1);

  // The fresh session opens the member profile before signing out.
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "E2E Discord Member", exact: true }),
  ).toBeVisible();

  // Return home so the captured cookie is the live one: every GET rotates
  // the session, so nothing may load between the capture and the click.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  const live = (await context.cookies()).find((item) => item.name === "__Host-two_session");
  expect(live?.value).toBeTruthy();

  // Sign out is a plain form POST whose 303 redirect commits as a full-page
  // navigation, so waitForResponse can miss the transient POST response (CI
  // browser-smoke timed out here). waitForRequest fires when the POST leaves,
  // before the navigation commits; the auto-retrying guest assertions below
  // then prove the 303 landed on / (the 303 status/location contract stays
  // pinned at unit level in test/auth-acceptance.test.ts).
  const logoutRequest = page.waitForRequest(
    (request) => request.url().endsWith("/logout") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  await logoutRequest;

  // The 303 lands on / as a guest: join CTA back, no member chrome.
  await expect(page).toHaveURL(`${localOrigin}/`);
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
      domain: "localhost",
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
  expect(homeHtml).not.toContain("E2E Discord Member");
  const profile = await context.request.get("/profile", { maxRedirects: 0 });
  expect(profile.status()).toBe(302);
  expect(profile.headers()["location"] ?? "").toContain("/auth/discord");
});
