import { accessibleJoinOneclick } from "../join-oneclick";
import { qaLoginRetryBudgetMs } from "../qa-login-retry.mjs";
import { test, expect, emptyStorageState, memberStorageState, stagingOrigin } from "./fixtures";
import { homeArrivalHeading } from "./home-arrival";
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
  const home = await page.goto("/");
  await expect(await homeArrivalHeading(page, home, "guest")).toBeVisible();
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

    const join = await page.goto("/join");
    if (!join) throw new Error("Missing /join navigation response");
    expect(join.status()).toBe(200);
    expect(join.url()).toBe(new URL("/join", stagingOrigin).href);
    expect(join.request().redirectedFrom()).toBeNull();
    const marker = await join.headerValue("x-two-renderer");
    expect([null, "kit"]).toContain(marker);
    const isKit = marker === "kit";
    // The staging journey gets no selector input. Log the response's renderer
    // separately from the candidate SHA verified by the workflow.
    console.log(`Staging /join observed renderer: ${isKit ? "kit" : "hono"} (not selector proof)`);

    await expect(
      page
        .getByRole("heading", {
          name: isKit ? "Play with people who show up." : "Join Together We Own",
          level: 1,
          exact: true,
        })
        .and(page.locator("#join-heading")),
    ).toBeVisible();
    const joinContent = isKit
      ? page.getByRole("complementary", { name: "Join with one sign-in", exact: true })
      : page.getByRole("region", { name: "Join Together We Own", exact: true });
    if (isKit) {
      await expect(
        joinContent
          .getByRole("heading", { name: "Join with one sign-in", level: 2, exact: true })
          .and(page.locator("#join-card-heading")),
      ).toBeVisible();
    }
    const oneclick = joinContent.getByTestId("join-oneclick");
    await expect(oneclick).toBeVisible();
    expect(await oneclick.getAttribute("href")).toBe("/join/discord");
    await expect(accessibleJoinOneclick(joinContent)).toBeVisible();

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
  // The config's 30s covers the login and the reads below; the login's
  // bounded 429 waits get their own budget (qa-login-retry.mjs), one login.
  test.setTimeout(30_000 + qaLoginRetryBudgetMs(1));
  await loginQaMember();
  test.info().annotations.push({
    type: "staging-revision",
    description: process.env.GITHUB_SHA ?? "local run",
  });
  const context = await browser.newContext({ storageState: memberStorageState });
  try {
    const authed = await context.newPage();
    const home = await authed.goto("/");
    await expect(await homeArrivalHeading(authed, home, "member")).toBeVisible();
    await authed.goto("/profile");
    await expect(authed.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
