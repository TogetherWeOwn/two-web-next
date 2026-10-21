import { qaLoginRetryBudgetMs } from "../qa-login-retry.mjs";
import { test, expect } from "./fixtures";
import { loginQaMember } from "./qa-login";

// Steam linking against the real Steam OpenID 2.0 endpoint. The journey never
// completes a Steam sign-in (no Steam credentials exist for the QA member), so
// it changes no staging state: it proves the deployed redirect is shaped so
// the real Steam accepts it, and that forged callbacks fail closed.
// Assumes the QA member has no Steam account linked: automation can never
// link one, since linking requires completing a real Steam sign-in.
test.beforeAll(async () => {
  test.setTimeout(30_000 + qaLoginRetryBudgetMs(1));
  await loginQaMember();
});

test("staging member starts Steam linking against the real Steam OpenID endpoint", async ({
  page,
}) => {
  await page.goto("/profile");
  await expect(page.getByText("Link Steam")).toBeVisible();
  const steamResponse = page.waitForResponse((response) =>
    response.url().startsWith("https://steamcommunity.com/openid/login"),
  );
  await page.goto("/profile/steam/link");
  // Steam serves its sign-in form (not an error page) only when realm and
  // return_to are well-formed and the request reaches the real endpoint.
  expect((await steamResponse).status()).toBe(200);
  expect(page.url()).toContain("steamcommunity.com/openid/login");
});

test("staging refuses a forged Steam assertion without linking", async ({ page }) => {
  const forged =
    "/profile/steam/callback?openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0" +
    "&openid.mode=id_res&openid.op_endpoint=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Flogin" +
    "&openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F76561198000000099" +
    "&openid.identity=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F76561198000000099" +
    "&openid.response_nonce=staging-forged-1&openid.sig=staging-forged";
  const res = await page.goto(forged);
  expect(res?.status()).toBe(422);
  await page.goto("/profile");
  await expect(page.getByText("Link Steam")).toBeVisible();
  expect(await page.content()).not.toContain("76561198000000099");
});
