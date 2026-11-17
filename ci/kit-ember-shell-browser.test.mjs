import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

test("built Ember shell preserves its landmarks and account states without JavaScript", {
  timeout: 720_000,
}, async () => {
  const source = await readFile(
    new URL("../test/fixtures/kit-ember-shell-route.svelte", import.meta.url),
    "utf8",
  );
  await mkdir("artifacts/kit-ember-shell", { recursive: true });
  for (const state of ["guest", "member", "hidden"]) {
    await withKitOfflineBrowser(
      { page: source, search: `?state=${state}` },
      async ({ page, html }) => {
        assert.match(html, /_app\/immutable\/assets\/[^" ]+\.css/);
        assert.equal(await page.locator('a[href="#main"]').count(), 1);
        assert.equal(
          await page
            .locator("[data-kit-site-header]")
            .evaluate((header) => getComputedStyle(header).display),
          "grid",
        );
        assert.equal(await page.getByRole("main").count(), 1);
        assert.equal(await page.getByRole("contentinfo").count(), 1);
        assert.equal(
          await page.getByRole("navigation", { name: "Account" }).count(),
          state === "hidden" ? 0 : 1,
        );
        assert.equal(
          await page.getByRole("link", { name: "Your profile" }).count(),
          state === "member" ? 1 : 0,
        );
        assert.equal(
          await page.getByRole("link", { name: "Sign in with Discord" }).count(),
          state === "guest" ? 1 : 0,
        );
        assert.equal(
          await page.getByRole("link", { name: "Leaderboard" }).count(),
          state === "member" ? 1 : 0,
        );
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
            path: `artifacts/kit-ember-shell/${state}-${viewport.width}.png`,
            fullPage: true,
          });
        }
      },
    );
  }
});
