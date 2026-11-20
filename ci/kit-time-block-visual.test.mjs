import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

test("built Kit time block renders required states with and without JavaScript", {
  timeout: 720_000,
}, async () => {
  const source = await readFile(
    new URL("../test/fixtures/kit-time-block-route.svelte", import.meta.url),
    "utf8",
  );
  await mkdir("artifacts/kit-time-block", { recursive: true });
  for (const javaScriptEnabled of [false, true]) {
    const options = {
      page: source,
      javaScriptEnabled,
      timezoneId: "UTC",
      headerMenu: true,
      csr: javaScriptEnabled,
    };
    await withKitOfflineBrowser(options, async ({ page, html }) => {
      assert.match(html, /_app\/immutable\/assets\/[^" ]+\.css/);
      const blocks = page.locator(".time-block");
      assert.equal(await blocks.count(), 7);
      assert.equal(
        await blocks.first().evaluate((block) => getComputedStyle(block).display),
        "flex",
      );
      if (javaScriptEnabled) {
        await blocks.nth(0).getByText("starts in 10 m", { exact: false }).waitFor();
        assert.equal(await blocks.nth(1).locator(":scope > time").innerText(), "Live");
        assert.match(await blocks.nth(1).innerText(), /since 19:30/);
      } else {
        assert.doesNotMatch(await blocks.nth(0).innerText(), /starts in/);
        assert.notEqual(await blocks.nth(1).locator(":scope > time").innerText(), "Live");
        assert.doesNotMatch(await blocks.nth(1).innerText(), /since 19:30|8 in the room/);
      }
      assert.match(await blocks.nth(2).innerText(), /live as of/i);
      assert.notEqual(await blocks.nth(2).locator(":scope > time").innerText(), "Live");
      assert.doesNotMatch(await blocks.nth(2).innerText(), /since 19:30|8 in the room/);
      assert.match(await blocks.nth(3).innerText(), /Echo frozen/);
      assert.match(await blocks.nth(4).innerText(), /\bEnded\s*$/);
      assert.match(await blocks.nth(5).innerText(), /Cancelled/);
      assert.match(await blocks.nth(6).innerText(), /Time to be confirmed/);
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: `artifacts/kit-time-block/${javaScriptEnabled ? "hydrated" : "no-js"}-${viewport.width}.png`,
          fullPage: true,
        });
      }
      const fixtureUrl = page.url();
      await page.goto(`${fixtureUrl}#stale`);
      const [refreshed] = await Promise.all([
        page.waitForResponse(
          (response) => response.url() === fixtureUrl && response.request().isNavigationRequest(),
        ),
        blocks.nth(2).getByRole("link", { name: "Refresh the event time" }).click(),
      ]);
      assert.equal(refreshed.status(), 200);
    });
  }
});
