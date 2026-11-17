// Exercise a built, JavaScript-disabled fixture without changing the source build.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";
import { assertTagStyles } from "./kit-tag-style-assertions.mjs";

test("built Tag variants resolve kit tokens", { timeout: 240_000 }, async () => {
  const source = await readFile(
    new URL("../test/fixtures/kit-tag-route.svelte", import.meta.url),
    "utf8",
  );
  await withKitOfflineBrowser({ page: source }, async ({ page, html }) => {
    assert.equal(new URL(page.url()).pathname, "/__browser_fixture__");
    assert.match(html, /_app\/immutable\/assets\/[^" ]+\.css/);
    assert.ok(
      await page.evaluate(() =>
        [...document.styleSheets].some((sheet) => sheet.href?.includes("/_app/")),
      ),
      "fixture loads built CSS",
    );
    await assertTagStyles(page);
  });
});
