import { type Browser, expect, type Page, test } from "@playwright/test";
import { serializeSigned } from "hono/utils/cookie";
import { JOIN_RESULT_COOKIE } from "../../src/return-journey";
import {
  KIT_ORIGIN,
  PARITY_VIEWPORTS,
  expectedKitMarker,
  kitFixtureSessionSecret,
  parityTargets,
} from "../kit-parity";

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

// Resize the rendered response rather than reloading: callback state and the
// confirmation are both single-use. The artifact names name the actual renderer.
async function captureJoin(page: Page, state: string) {
  for (const { name, size } of PARITY_VIEWPORTS) {
    await page.setViewportSize(size);
    if (state === "kit-guest" && name === "mobile") {
      const lede = await page.locator(".join-lede").boundingBox();
      const card = await page.locator(".join-lede + .join-card").boundingBox();
      if (!lede || !card) throw new Error("The mobile Join card must follow the lede.");
      expect(card.y).toBeGreaterThanOrEqual(lede.y + lede.height);
    }
    const label = `kit-review-join-${state}-${name}`;
    const path = test.info().outputPath(`${label}.png`);
    await page.screenshot({ path, animations: "disabled", scale: "css" });
    await test.info().attach(label, { path, contentType: "image/png" });
  }
}

test("Kit home consumes the signed join flash on GET only", async ({ request }) => {
  const signed = await serializeSigned(
    JOIN_RESULT_COOKIE,
    "already_member",
    kitFixtureSessionSecret(),
    { path: "/", secure: true },
  );
  const headers = { cookie: signed.split(";")[0]! };
  const head = await request.head(`${KIT_ORIGIN}/`, { headers });
  expect(head.status()).toBe(200);
  expect(head.headers()["set-cookie"]).toBeUndefined();

  const home = await request.get(`${KIT_ORIGIN}/`, { headers });
  expect(home.status()).toBe(200);
  expect(home.headers()["x-two-renderer"] ?? null).toBe(expectedKitMarker("/"));
  expect(home.headers()["set-cookie"]).toMatch(
    new RegExp(`^${JOIN_RESULT_COOKIE}=;.*Max-Age=0`, "i"),
  );
  expect(await home.text()).toContain('data-testid="join-result"');
  const revisit = await request.get(`${KIT_ORIGIN}/`);
  expect(revisit.status()).toBe(200);
  expect(await revisit.text()).not.toContain('data-testid="join-result"');
});

for (const target of targets) {
  test(`${target.name}: guest join CTA enters the Hono-owned OAuth flow`, async ({ browser }) => {
    const context = await isolatedPage(browser, target);
    try {
      const page = await context.newPage();
      const oauthResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/join/discord",
      );
      const returnTo = "/join?source=home";
      const landing = await page.goto(`/join?next=${encodeURIComponent(returnTo)}`);
      expect(landing?.status()).toBe(200);
      expect(landing?.headers()["x-two-renderer"] ?? null).toBe(
        target.name === "kit" ? "kit" : null,
      );
      await expect(page.getByText("Welcome, guest")).toBeVisible();
      await expect(page.getByText("Sign out")).toHaveCount(0);

      const cta = page.getByTestId("join-oneclick");
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute(
        "href",
        `/join/discord?next=${encodeURIComponent(returnTo)}`,
      );
      await captureJoin(page, `${target.name}-guest`);
      await cta.click();
      const oauth = await oauthResponse;
      expect(oauth.status()).toBe(302);
      expect(oauth.headers()["x-two-renderer"] ?? null).toBeNull();
      const location = oauth.headers()["location"];
      expect(location).toBeTruthy();
      const authorize = new URL(location!);
      expect(authorize.origin + authorize.pathname).toBe(AUTHORIZE_URL);
      expect(authorize.searchParams.get("scope")).toBe("identify guilds.join");
      const state = authorize.searchParams.get("state");
      expect(state).toBeTruthy();
      expect((await context.cookies()).some((cookie) => cookie.name === "__Host-two_session")).toBe(
        false,
      );

      // The worker's existing Discord stub reports an existing guild member.
      // Use the real state and browser cookie jar, without contacting Discord.
      const callbackResponse = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/join/callback",
      );
      const query = new URLSearchParams({ code: "e2e-code", state: state! });
      const returned = await page.goto(`/join/callback?${query}`);
      const callback = await callbackResponse;
      expect(callback.status()).toBe(302);
      expect(callback.headers()["x-two-renderer"] ?? null).toBeNull();
      expect(callback.headers().location).toBe(returnTo);
      await expect(page).toHaveURL(`${target.origin}${returnTo}`);
      expect(returned?.status()).toBe(200);
      expect(returned?.headers()["x-two-renderer"] ?? null).toBe(
        target.name === "kit" ? "kit" : null,
      );
      expect(returned?.headers()["cache-control"]).toMatch(
        /^(private, no-store|no-store, private)$/,
      );
      const status = await context.request.get("/auth/status");
      expect(status.status()).toBe(200);
      expect(await status.json()).toEqual({ authenticated: true });
      await expect(page.getByTestId("join-result")).toContainText("You are already in the server.");
      await expect(page.getByTestId("reinvite-link")).toHaveAttribute("href", "/discord");
      if (target.name === "kit") await captureJoin(page, "kit-existing-member");
      await page.reload();
      await expect(page.getByTestId("join-result")).toHaveCount(0);
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
        target.name === "kit" ? "kit" : null,
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
      await captureJoin(page, `${target.name}-expired-session`);

      // Obtain a valid one-use state cookie from the Hono-owned start route,
      // then inject a provider denial. The callback is a failure outcome and
      // must remain Hono-owned even when requested through the Kit worker.
      const start = await context.request.get(`${target.origin}/join/discord`, { maxRedirects: 0 });
      expect(start.status()).toBe(302);
      expect(start.headers()["x-two-renderer"] ?? null).toBeNull();
      const startLocation = start.headers()["location"];
      expect(startLocation).toBeTruthy();
      const authorize = new URL(startLocation!);
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
      if (target.name === "kit") await captureJoin(page, "hono-denied");

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

      // Both the Hono and Kit E2E workers install deterministic outbound
      // Discord stubs, so callback outcomes never make upstream requests.
      const blockedStart = await context.request.get(`${target.origin}/join/discord`, {
        maxRedirects: 0,
      });
      const blockedLocation = blockedStart.headers()["location"];
      expect(blockedLocation).toBeTruthy();
      const blockedState = new URL(blockedLocation!).searchParams.get("state");
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
      if (target.name === "kit") await captureJoin(page, "hono-bot-fallback");

      // The OAuth token-exchange fixture injects a deterministic upstream
      // outage; it preserves Hono's 503/private response and never signs in.
      const outageStart = await context.request.get(`${target.origin}/join/discord`, {
        maxRedirects: 0,
      });
      const outageLocation = outageStart.headers()["location"];
      expect(outageLocation).toBeTruthy();
      const outageState = new URL(outageLocation!).searchParams.get("state");
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
      if (target.name === "kit") await captureJoin(page, "hono-oauth-outage");
    } finally {
      await context.close();
    }
  });
}
