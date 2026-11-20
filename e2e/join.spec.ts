import { test, expect, localOrigin } from "./fixtures";
import { accessibleJoinOneclick } from "./join-oneclick";

test("the one-click Join locator rejects an aria-hidden anchor", async ({ page }) => {
  await page.setContent(`
    <section aria-label="Join Together We Own">
      <a data-testid="join-oneclick" href="/join/discord" aria-hidden="true">Join with Discord</a>
      <a href="/join/discord">Join with Discord</a>
    </section>
  `);
  const landmark = page.getByRole("region", { name: "Join Together We Own", exact: true });
  const oneclick = landmark.getByTestId("join-oneclick");
  const accessibleLink = accessibleJoinOneclick(landmark);

  // The old checks pass, and the other accessible link cannot stand in for this anchor.
  await expect(oneclick).toBeVisible();
  await expect(oneclick).toHaveAttribute("href", "/join/discord");
  await expect(accessibleLink).toHaveCount(0);

  await oneclick.evaluate((link) => link.removeAttribute("aria-hidden"));
  await expect(accessibleLink).toBeVisible();
  await expect(accessibleLink).toHaveAttribute("href", "/join/discord");
});

test("homepage join CTA completes stubbed Discord OAuth and opens the member profile", async ({
  page,
  context,
}) => {
  let authorizations = 0;
  await context.route(`${localOrigin}/auth/discord`, async (route) => {
    // Intercept the local entry before its server redirect: Playwright does
    // not re-run URL handlers for redirect hops. Fetch only the local route.
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(302);
    authorizations++;
    const url = new URL(response.headers().location!);
    expect(url.origin).toBe("https://discord.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("e2e-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://next.togetherweown.com/auth/discord/callback",
    );
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    // Keep the production state cookies, but replace the authorize hop with
    // the stub's local callback. No Discord authorize request is sent.
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
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "E2E Discord Member", exact: true }),
  ).toBeVisible();
  const response = await context.request.get("/__e2e/network", { maxRedirects: 0 });
  const { outbound } = await response.json();
  expect(outbound).toEqual(
    expect.arrayContaining([
      "POST https://discord.com/api/v10/oauth2/token",
      "GET https://discord.com/api/v10/users/@me",
      "PUT https://discord.com/api/v10/guilds/326474832151838730/members/900000000000001398",
    ]),
  );
});
