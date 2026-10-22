import AxeBuilder from "@axe-core/playwright";
import { test, expect, localOrigin } from "./fixtures";

// Builder-owned local Worker fixtures (never real provider accounts):
// ...001: active Twitch; ...002: active YouTube; ...003: active, HLS only;
// ...004: offline, schedule + last-live. Keep these read-only and deterministic.
const user = (suffix: string) => `01K0000000000000000000000${suffix}`;
const livePath = (suffix: string) => `/members/${user(suffix)}/live`;

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test.describe(`stream live without JavaScript at ${viewport.width}px`, () => {
    test.use({ javaScriptEnabled: false, viewport });

    for (const scenario of [
      { suffix: "1", state: "live" },
      { suffix: "4", state: "offline" },
    ]) {
      test(`${scenario.state} content and recovery links are usable`, async ({ page }, info) => {
        const response = await page.goto(localOrigin + livePath(scenario.suffix));
        expect(response?.status()).toBe(200);
        await expect(page.locator(`[data-stream-state="${scenario.state}"]`)).toBeVisible();
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const main = page.getByRole("main");
        const watch = main
          .locator(scenario.state === "live" ? "a[data-stream-watch]" : "a[data-stream-follow]")
          .first();
        await expect(watch).toBeVisible();
        expect(await watch.getAttribute("href")).toMatch(/^https:\/\/(?:www\.)?twitch\.tv\//);
        await expect(main.locator("a[data-stream-report]")).toBeVisible();
        if (scenario.state === "offline") {
          await expect(main.getByText("Fridays at 18:00 UTC")).toBeVisible();
          await expect(main.locator("time[datetime]")).toBeVisible();
          await expect(main.locator("a[data-stream-join]")).toBeVisible();
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await info.attach(`${scenario.state}-${viewport.width}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      });
    }
  });
}

test.describe("stream player facade", () => {
  for (const scenario of [
    { suffix: "1", host: "player.twitch.tv" },
    { suffix: "2", host: "www.youtube-nocookie.com" },
    { suffix: "3", host: "customer-example.cloudflarestream.com" },
  ]) {
    test(`${scenario.host} loads only after keyboard activation, never with audible autoplay`, async ({
      page,
    }) => {
      const requests: string[] = [];
      // Local browser safety still refuses the network. Stub only the player
      // document so creating its frame is observable without paid delivery.
      await page.route(`https://${scenario.host}/**`, async (route) => {
        requests.push(route.request().url());
        await route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Fixture player</title>",
        });
      });
      const response = await page.goto(localOrigin + livePath(scenario.suffix));
      expect(response?.status()).toBe(200);
      await expect(page.locator('[data-stream-state="live"]')).toBeVisible();
      expect(requests).toEqual([]);
      await expect(page.locator("iframe, video")).toHaveCount(0);
      const play = page.locator("button[data-stream-play]");
      await expect(play).toHaveAccessibleName(/watch|play/i);
      await play.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("iframe, video")).toHaveCount(1);
      const media = page.locator("iframe, video");
      const isFrame = await media.evaluate((element) => element.tagName === "IFRAME");
      if (!isFrame) {
        expect(scenario.suffix).toBe("3");
        const native = page.locator("video");
        const properties = await native.evaluate((element) => {
          if (!(element instanceof HTMLVideoElement))
            throw new Error("Expected the native HLS player");
          return {
            source: element.currentSrc || element.src || element.querySelector("source")?.src,
            autoplay: element.autoplay,
            muted: element.muted,
            controls: element.controls,
          };
        });
        expect(new URL(properties.source!).hostname).toBe(scenario.host);
        expect(properties.source).toMatch(/\/manifest\/video\.m3u8(?:\?|$)/);
        expect(!properties.autoplay || properties.muted).toBe(true);
        expect(properties.controls).toBe(true);
      } else {
        await expect(media).toHaveAttribute("title", /\S/);
        const player = new URL((await media.getAttribute("src"))!);
        expect(player.hostname).toBe(scenario.host);
        if (scenario.suffix === "1") {
          expect(player.searchParams.getAll("parent")).toEqual([new URL(localOrigin).hostname]);
        }
        const autoplay = ["1", "true"].includes(
          player.searchParams.get("autoplay") ?? (scenario.suffix === "1" ? "true" : "false"),
        );
        const muted = ["1", "true"].includes(
          player.searchParams.get("muted") ?? player.searchParams.get("mute") ?? "",
        );
        expect(!autoplay || muted).toBe(true);
        await expect.poll(() => requests.length).toBe(1);
      }
    });
  }
});

for (const scenario of [
  { suffix: "1", state: "live" },
  { suffix: "4", state: "offline" },
]) {
  test(`stream ${scenario.state} page has no serious or critical accessibility violations`, async ({
    page,
  }) => {
    const response = await page.goto(localOrigin + livePath(scenario.suffix));
    expect(response?.status()).toBe(200);
    await expect(page.locator(`[data-stream-state="${scenario.state}"]`)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const result = await new AxeBuilder({ page }).analyze();
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
}
