import { test, expect, localOrigin } from "./fixtures";

test("homepage join CTA completes stubbed Discord OAuth and opens the member profile", async ({ page, context }) => {
  let authorizations = 0;
  await context.route("https://discord.com/oauth2/authorize**", async (route) => {
    authorizations++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("client_id")).toBe("e2e-client");
    expect(url.searchParams.get("redirect_uri")).toBe("https://next.togetherweown.com/auth/discord/callback");
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    // Fulfill the authorize navigation locally; never route.fetch() Discord.
    await route.fulfill({ status: 302, headers: {
      location: `${localOrigin}/auth/discord/callback?code=e2e-code&state=${encodeURIComponent(state!)}`,
    } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The lobby is open." })).toBeVisible();
  await page.getByTestId("join").click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(authorizations).toBe(1);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "E2E Discord Member", exact: true })).toBeVisible();
  const response = await context.request.get("/__e2e/network");
  const { outbound } = await response.json();
  expect(outbound).toEqual(expect.arrayContaining([
    "POST https://discord.com/api/v10/oauth2/token",
    "GET https://discord.com/api/v10/users/@me",
    "PUT https://discord.com/api/v10/guilds/326474832151838730/members/900000000000001398",
  ]));
});
