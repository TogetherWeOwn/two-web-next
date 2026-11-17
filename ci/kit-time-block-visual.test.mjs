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
    await withKitOfflineBrowser({ page: source, javaScriptEnabled }, async ({ page, html }) => {
      assert.match(html, /_app\/immutable\/assets\/[^" ]+\.css/);
      const blocks = page.locator(".time-block");
      assert.equal(await blocks.count(), 6);
      assert.equal(
        await blocks.first().evaluate((block) => getComputedStyle(block).display),
        "flex",
      );
      if (javaScriptEnabled) {
        await blocks.nth(0).getByText("starts in 10 m", { exact: false }).waitFor();
        assert.match(await blocks.nth(1).innerText(), /Live since/);
      } else {
        assert.doesNotMatch(await blocks.nth(0).innerText(), /starts in/);
        assert.doesNotMatch(await blocks.nth(1).innerText(), /Live since|8 in the room/);
      }
      assert.match(await blocks.nth(2).innerText(), /live as of/i);
      assert.doesNotMatch(await blocks.nth(2).innerText(), /Live since|8 in the room/);
      assert.match(await blocks.nth(3).innerText(), /Echo frozen/);
      assert.match(await blocks.nth(4).innerText(), /Cancelled/);
      assert.match(await blocks.nth(5).innerText(), /Time to be confirmed/);
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
    });
  }
});
