import { test, expect, emptyStorageState, memberStorageState } from "./fixtures";
import { loginQaMember } from "./qa-login";

// Join-funnel staging journey. Runs explicitly unauthenticated for the funnel
// half (a bare newContext() would inherit the member storageState from the
// staging config), then uses its own fresh QA member session for the profile
// half — one login, and the authed reads happen after it, so page-view bearer
// rotation cannot consume the session before the profile assertion.
test.use({ storageState: emptyStorageState });

// Guest funnel: the homepage join CTA and the /join one-click entry both stay
// 200 and point at the OAuth entries. No real Discord request is sent: both
// entries are probed with maxRedirects 0, so the 302 Location headers are
// asserted without following them to Discord.
test("staging join funnel answers without a session and entries redirect to Discord", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The lobby is open." })).toBeVisible();
  const cta = page.getByTestId("join");
  await expect(cta).toBeVisible();
  expect(await cta.getAttribute("href")).toBe("/auth/discord");

  // Explicitly empty: the `request` fixture does not inherit this file's
  // storageState override, so probe through a guest context like auth.spec.
  const guest = await browser.newContext({ storageState: emptyStorageState });
  try {
    const loginEntry = await guest.request.get("/auth/discord", { maxRedirects: 0 });
    expect(loginEntry.status()).toBe(302);
    expect(loginEntry.headers().location ?? "").toMatch(
      /^https:\/\/discord\.com\/oauth2\/authorize/,
    );

    await page.goto("/join");
    await expect(page.getByRole("heading", { name: "Join Together We Own" })).toBeVisible();
    const oneclick = page.getByTestId("join-oneclick");
    await expect(oneclick).toBeVisible();
    expect(await oneclick.getAttribute("href")).toBe("/join/discord");

    const joinEntry = await guest.request.get("/join/discord", { maxRedirects: 0 });
    expect(joinEntry.status()).toBe(302);
    expect(joinEntry.headers().location ?? "").toMatch(
      /^https:\/\/discord\.com\/oauth2\/authorize/,
    );
  } finally {
    await guest.close();
  }
});

// QA seam half: the stubbed sign-in lands on the member profile. No real
// Discord request, no writes beyond the QA identity — the seam issues a
// normal DB session through the same store and cookie as a Discord login,
// with the synthetic QA member identity. The tested staging revision is
// recorded as a report annotation (the runner sets GITHUB_SHA), so a result
// names the Worker build it ran against.
test("staging QA member session opens the member profile after the funnel", async ({ browser }) => {
  await loginQaMember();
  test.info().annotations.push({
    type: "staging-revision",
    description: process.env.GITHUB_SHA ?? "local run",
  });
  const context = await browser.newContext({ storageState: memberStorageState });
  try {
    const authed = await context.newPage();
    await authed.goto("/");
    await expect(authed.getByRole("heading", { name: "The lobby is open." })).toBeVisible();
    await authed.goto("/profile");
    await expect(authed.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
