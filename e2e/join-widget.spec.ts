import { test, expect } from "./fixtures";

// Browser pin for the click-to-load Discord preview facade on /join: page
// load renders a no-referrer link and the island script with no iframe and no
// Discord traffic, and a plain click swaps the link for the sandboxed widget
// frame with focus moving in once the stubbed widget signals load. Unit
// parity lives in test/join.test.ts (which
// pins the data-join-widget markup-to-island hook against the real SSR HTML)
// and test/islands-join-widget.test.ts; this spec proves the same path
// through the browser against wrangler dev + CI Postgres only. It never
// touches staging or production: the widget document is stubbed locally.
const WIDGET_URL = "https://discord.com/widget?id=326474832151838730&theme=dark";

// Discord's own widget headers, mirroring e2e/watch-guard.mjs, so the frame
// loads under the site's COEP credentialless policy.
const WIDGET_STUB_HEADERS = {
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "cross-origin",
};
const WIDGET_STUB_BODY = "<!doctype html><title>discord widget (stubbed)</title>";

test("join preview makes no Discord request until clicked, then frames the widget", async ({
  page,
  context,
}) => {
  const consoleNoise: string[] = [];
  page.on("console", (message) => {
    // Resource-load failures are browser reports, not page logging; the pin
    // is that the facade leaks nothing via console.error/warn.
    if (message.text().startsWith("Failed to load resource")) return;
    if (message.type() === "error" || message.type() === "warning") {
      consoleNoise.push(`${message.type()}: ${message.text()}`);
    }
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
  });
  const discordRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === "https://discord.com") {
      discordRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    }
  });

  // Answer the widget document locally: the frame must never reach Discord,
  // and the isolation guard would fail the run on real external traffic.
  await context.route(
    (url) => url.origin === "https://discord.com" && url.pathname === "/widget",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: WIDGET_STUB_HEADERS,
        body: WIDGET_STUB_BODY,
      });
    },
  );

  const response = await page.goto("/join");
  expect(response?.status()).toBe(200);

  // The facade: a link to the widget page, the island, no iframe, and no
  // Discord request on load. Without the data-join-widget hook the island
  // stays inert and the click below navigates away instead of framing.
  const link = page.getByTestId("join-widget-load");
  await expect(link).toBeVisible();
  expect(await link.getAttribute("href")).toBe(WIDGET_URL);
  expect(await link.getAttribute("data-join-widget")).not.toBeNull();
  await expect(page.locator('iframe[data-testid="join-widget"]')).toHaveCount(0);
  expect(discordRequests).toEqual([]);

  await link.click();

  // One click builds exactly one frame from the link href, sandboxed with no
  // referrer at the documented size; the stubbed widget loads, so focus moves
  // into the frame on load.
  const frame = page.locator('iframe[data-testid="join-widget"]');
  await expect(frame).toHaveCount(1);
  expect(await frame.getAttribute("src")).toBe(WIDGET_URL);
  expect(await frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  expect(await frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(await frame.getAttribute("width")).toBe("350");
  expect(await frame.getAttribute("height")).toBe("500");
  await expect(frame).toBeFocused();
  expect(discordRequests).toEqual(["GET https://discord.com/widget"]);

  expect(consoleNoise, "no console errors or warnings").toEqual([]);
  expect(pageErrors, "no uncaught page errors").toEqual([]);
});
