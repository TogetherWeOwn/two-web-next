import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const names = ["Prospect", "Member", "Soldier", "Veteran", "Legend"];
const directory = "artifacts/kit-rank";
const viewports = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

test("built Kit renders both rank sizes with text fallback and forced colours", {
  timeout: 720_000,
}, async () => {
  const source = await readFile(
    new URL("../test/fixtures/kit-rank-route.svelte", import.meta.url),
    "utf8",
  );
  await mkdir(directory, { recursive: true });
  await withKitOfflineBrowser({ page: source, javaScriptEnabled: true }, async ({ page, html }) => {
    assert.match(html, /_app\/immutable\/assets\/[^" ]+\.css/);
    for (const name of names) assert.ok(html.includes(`>${name}</span>`), name);
    const labels = page.locator("main .rank-label");
    const strokes = () =>
      labels
        .locator("path")
        .evaluateAll((paths) => paths.map((path) => getComputedStyle(path).stroke));
    const capture = async (state, viewport) => {
      await page.setViewportSize(viewport);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(await labels.locator(":scope > span").allInnerTexts(), [...names, ...names]);
      await page.screenshot({ path: `${directory}/${viewport.width}-${state}.png` });
    };
    const glyphs = labels.locator('svg[aria-hidden="true"]');
    assert.deepEqual(
      await glyphs.evaluateAll((icons) => icons.map((icon) => icon.getBoundingClientRect().width)),
      [...names.map(() => 20), ...names.map(() => 44)],
    );
    assert.equal(await labels.first().evaluate((el) => getComputedStyle(el).columnGap), "8px");
    const normal = await strokes();
    assert.equal(normal.length, 50);
    assert.equal(normal.includes("none"), false);
    assert.equal(new Set(normal).size, 4);
    for (const viewport of viewports) {
      await capture("ranks", viewport);
      const { violations } = await new AxeBuilder({ page }).include("main").analyze();
      assert.deepEqual(
        violations.filter(({ impact }) => impact === "critical" || impact === "serious"),
        [],
      );
    }
    await page.emulateMedia({ forcedColors: "active" });
    const forced = await strokes();
    assert.equal(forced.includes("none"), false);
    assert.notEqual(forced[0], forced[1]);
    for (const viewport of viewports) await capture("forced-colours", viewport);

    await page.emulateMedia({ forcedColors: "none" });
    // Simulate loss of the component stylesheet, keeping the app shell loaded.
    await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        if ([...sheet.cssRules].some((rule) => rule.cssText.includes(".rank-label")))
          sheet.disabled = true;
      }
    });
    assert.deepEqual(await strokes(), Array(50).fill("none"));
    for (const viewport of viewports) await capture("text-fallback", viewport);
  });
});
