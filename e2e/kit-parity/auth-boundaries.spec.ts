import { expect, test, type Browser } from "@playwright/test";
import { expectedKitMarker, KIT_ORIGIN, parityTargets } from "../kit-parity";

const targets = parityTargets();
const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";

async function isolatedPage(browser: Browser, target: (typeof targets)[number]) {
  const { origin } = target;
  const context = await browser.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: target.ignoreHTTPSErrors,
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.origin === KIT_ORIGIN) return route.continue();
    if (url.origin === "https://discord.com" && url.pathname === "/oauth2/authorize") {
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<title>OAuth stub</title>",
      });
    }
    return route.abort("blockedbyclient");
  });
  return context;
}

for (const target of targets) {
  test(`${target.name}: guest join CTA enters the Hono-owned OAuth flow`, async ({ browser }) => {
    const context = await isolatedPage(browser, target);
    try {
      const page = await context.newPage();
      const oauthResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/join/discord",
      );
      const landing = await page.goto(`${target.origin}/join`);
      expect(landing?.status()).toBe(200);
      await expect(page.getByText("Welcome, guest")).toBeVisible();
      await expect(page.getByText("Sign out")).toHaveCount(0);

      const cta = page.getByTestId("join-oneclick");
      await expect(cta).toBeVisible();
      expect(await cta.getAttribute("href")).toBe("/join/discord");
      await cta.click();
      const oauth = await oauthResponse;
      expect(oauth.status()).toBe(302);
      expect(oauth.headers()["x-two-renderer"] ?? null).toBeNull();
      const authorize = new URL(page.url());
      expect(authorize.origin + authorize.pathname).toBe(AUTHORIZE_URL);
      expect(authorize.searchParams.get("scope")).toBe("identify guilds.join");
      expect(authorize.searchParams.get("state")).toBeTruthy();
      expect((await context.cookies()).some((cookie) => cookie.name === "__Host-two_session")).toBe(
        false,
      );
    } finally {
      await context.close();
    }
  });

  test(`${target.name}: recovery and failed callback preserve Hono status/cache without a session`, async ({
    browser,
  }) => {
    const context = await isolatedPage(browser, target);
    try {
      const page = await context.newPage();
      const query = "?next=%2Fprofile%3Fedit%3D1";
      const recovery = await page.goto(`${target.origin}/auth/recover${query}`);
      expect(recovery?.status()).toBe(200);
      expect(recovery?.headers()["cache-control"]).toBe("no-store, private");
      expect(recovery?.headers()["x-two-renderer"] ?? null).toBe(
        target.name === "kit" ? expectedKitMarker("/auth/recover") : null,
      );
      await expect(page.getByRole("heading", { name: "Your session expired" })).toBeVisible();
      await expect(page.getByTestId("recovery-retry")).toHaveAttribute(
        "href",
        "/auth/discord?next=%2Fprofile%3Fedit%3D1",
      );
      await expect(page.getByTestId("recovery-invite")).toHaveAttribute("href", "/discord");
      expect((await context.cookies()).some((cookie) => cookie.name === "__Host-two_session")).toBe(
        false,
      );

      // Obtain a valid one-use state cookie from the Hono-owned start route,
      // then inject a provider denial. The callback is a failure outcome and
      // must remain Hono-owned even when requested through the Kit worker.
      const start = await context.request.get(`${target.origin}/join/discord`, { maxRedirects: 0 });
      expect(start.status()).toBe(302);
      expect(start.headers()["x-two-renderer"] ?? null).toBeNull();
      const authorize = new URL(start.headers()["location"]!);
      const state = authorize.searchParams.get("state");
      expect(state).toBeTruthy();

      const callback = await page.goto(
        `${target.origin}/join/callback?error=access_denied&state=${encodeURIComponent(state!)}`,
      );
      expect(callback?.status()).toBe(200);
      expect(callback?.headers()["cache-control"]).toBe("no-store, private");
      expect(callback?.headers()["x-two-renderer"] ?? null).toBeNull();
      await expect(page.getByRole("heading", { name: "Join cancelled" })).toBeVisible();
      await expect(page.getByTestId("recovery-retry")).toHaveAttribute("href", "/join/discord");
      await expect(page.getByTestId("recovery-invite")).toBeVisible();
      expect((await context.cookies()).some((cookie) => cookie.name === "__Host-two_session")).toBe(
        false,
      );
      expect((await callback?.allHeaders())?.["set-cookie"] ?? "").not.toContain(
        "__Host-two_session=",
      );

      // A callback with an unusable one-use state renders the expired outcome,
      // still as a private Hono response with no session issuance.
      const expired = await page.goto(`${target.origin}/join/callback?code=fixture&state=stale`);
      expect(expired?.status()).toBe(200);
      expect(expired?.headers()["cache-control"]).toBe("no-store, private");
      expect(expired?.headers()["x-two-renderer"] ?? null).toBeNull();
      await expect(page.getByRole("heading", { name: "Join link expired" })).toBeVisible();
      expect((await context.cookies()).some((cookie) => cookie.name === "__Host-two_session")).toBe(
        false,
      );
      expect((await expired?.allHeaders())?.["set-cookie"] ?? "").not.toContain(
        "__Host-two_session=",
      );

      // Inject the deterministic bot-refusal fixture as another recovery
      // outcome. The Kit target still delegates the callback to Hono.
      const blockedStart = await context.request.get(`${target.origin}/join/discord`, {
        maxRedirects: 0,
      });
      const blockedState = new URL(blockedStart.headers()["location"]!).searchParams.get("state");
      expect(blockedState).toBeTruthy();
      const blocked = await page.goto(
        `${target.origin}/join/callback?code=e2e-blocked-code&state=${encodeURIComponent(blockedState!)}`,
      );
      expect(blocked?.status()).toBe(200);
      expect(blocked?.headers()["cache-control"]).toBe("no-store, private");
      expect(blocked?.headers()["x-two-renderer"] ?? null).toBeNull();
      await expect(
        page.getByRole("heading", { name: "We couldn't add you automatically" }),
      ).toBeVisible();
      expect((await context.cookies()).some((cookie) => cookie.name === "__Host-two_session")).toBe(
        false,
      );
      expect((await blocked?.allHeaders())?.["set-cookie"] ?? "").not.toContain(
        "__Host-two_session=",
      );

      // The OAuth token-exchange fixture injects a deterministic upstream
      // outage; it preserves Hono's 503/private response and never signs in.
      const outageStart = await context.request.get(`${target.origin}/join/discord`, {
        maxRedirects: 0,
      });
      const outageState = new URL(outageStart.headers()["location"]!).searchParams.get("state");
      expect(outageState).toBeTruthy();
      const outage = await page.goto(
        `${target.origin}/join/callback?code=e2e-outage-code&state=${encodeURIComponent(outageState!)}`,
      );
      expect(outage?.status()).toBe(503);
      expect(outage?.headers()["cache-control"]).toBe("no-store, private");
      expect(outage?.headers()["x-two-renderer"] ?? null).toBeNull();
      await expect(page.getByRole("heading", { name: "Discord is unreachable" })).toBeVisible();
      expect((await context.cookies()).some((cookie) => cookie.name === "__Host-two_session")).toBe(
        false,
      );
      expect((await outage?.allHeaders())?.["set-cookie"] ?? "").not.toContain(
        "__Host-two_session=",
      );
    } finally {
      await context.close();
    }
  });
}
