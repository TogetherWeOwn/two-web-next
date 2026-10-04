import { test, expect } from "./fixtures";

// Offline parity for the legacy blocked-join browser behaviour: when Discord
// refuses the guild add, the one-click journey renders the blocked-outcome
// recovery copy with a retry and an invite fallback, and never signs in.
// Unit parity lives in test/join-blocked-copy.test.ts; this spec proves the
// same path through the browser against wrangler dev + CI Postgres only.
// It never touches staging or production: no QA token, no live guild write.
const BLOCKED_CODE = "e2e-blocked-code";
const INVITE_URL = "https://discord.gg/e2e-never-follow";
const MEMBER_PUT =
  "PUT https://discord.com/api/v10/guilds/326474832151838730/members/900000000000001398";

test("bot-refused join renders the blocked copy with retry and invite, without signing in", async ({
  page,
  context,
}) => {
  // Start the one-click journey without rendering /join (its Discord widget
  // iframe is external traffic the isolation guard forbids): fetch the local
  // entry only, validate the Discord authorize redirect, keep the state cookie.
  const entry = await context.request.get("/join/discord", { maxRedirects: 0 });
  expect(entry.status()).toBe(302);
  const rawLocation = entry.headers()["location"];
  expect(rawLocation).toBeTruthy();
  const authorize = new URL(rawLocation!);
  expect(authorize.origin).toBe("https://discord.com");
  expect(authorize.pathname).toBe("/oauth2/authorize");
  expect(authorize.searchParams.get("client_id")).toBe("e2e-client");
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    "https://next.togetherweown.com/join/callback",
  );
  expect(authorize.searchParams.get("scope")).toBe("identify guilds.join");
  const state = authorize.searchParams.get("state");
  expect(state).toBeTruthy();

  // Finish in the browser with the blocked-join code: the test Worker answers
  // the token exchange, then refuses the guild add (403), so the app must
  // render the blocked recovery page with status 200 and no session.
  const callback = `/join/callback?code=${BLOCKED_CODE}&state=${encodeURIComponent(state!)}`;
  const response = await page.goto(callback);
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "We couldn't add you automatically" }),
  ).toBeVisible();
  await expect(page.getByText("use the invite link below")).toBeVisible();
  const retry = page.getByTestId("recovery-retry");
  await expect(retry).toBeVisible();
  expect(await retry.getAttribute("href")).toBe("/join/discord");
  const invite = page.getByTestId("recovery-invite");
  await expect(invite).toBeVisible();
  expect(await invite.getAttribute("href")).toBe(INVITE_URL);
  // Distinct from the denied, outage and expired recoveries.
  for (const other of [
    "Join cancelled",
    "Discord is unreachable",
    "Join approval expired",
    "Join link expired",
  ]) {
    await expect(page.getByText(other)).toHaveCount(0);
  }

  // Never a member session: the browser holds no session cookie, the home
  // page stays guest, and the profile bounces to the OAuth flow.
  expect(
    (await context.cookies()).find((item) => item.name === "__Host-two_session"),
  ).toBeUndefined();
  const home = await context.request.get("/", { maxRedirects: 0 });
  expect(home.status()).toBe(200);
  const homeHtml = await home.text();
  expect(homeHtml).toContain("Join with Discord");
  expect(homeHtml).not.toContain("E2E Discord Member");
  const profile = await context.request.get("/profile", { maxRedirects: 0 });
  expect(profile.status()).toBe(302);
  expect(profile.headers()["location"] ?? "").toContain("/auth/discord");

  // The guild-add attempt really ran: without this the recovery could come
  // from an expired state instead of the bot refusal.
  const network = await context.request.get("/__e2e/network", { maxRedirects: 0 });
  expect(await network.json()).toMatchObject({
    outbound: expect.arrayContaining([MEMBER_PUT]),
  });
});
