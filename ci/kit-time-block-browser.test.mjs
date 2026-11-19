import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { compileKitFixture } from "./kit-hydration-harness.mjs";

const fixture = resolve(process.cwd(), "test/fixtures/TimeBlockBrowserFixture.svelte");

test("time block hydrates and withdraws expired snapshot claims", {
  timeout: 120_000,
}, async () => {
  const { body: html, js: client } = await compileKitFixture({ fixture });
  const asOf = "2026-11-07T19:20:00Z";
  assert.doesNotMatch(html, /starts in|Live since|your time/);
  assert.match(html, /UTC fallback/);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ timezoneId: "America/New_York" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install({ time: new Date(asOf) });
    await page.setContent(`<div id="fixture">${html}</div>`);
    await page.addScriptTag({ content: client });
    await page.getByText("starts in 10 m").waitFor();
    assert.equal(await page.getByRole("link", { name: /Refresh/ }).count(), 0);
    const hydratedText = await page.locator(".time-block").innerText();
    assert.match(hydratedText, /America\/New_York/);
    assert.match(hydratedText, /your time \(from your browser\)/);
    assert.doesNotMatch(hydratedText, /UTC fallback/);
    await page.clock.fastForward(60_000);
    await page.getByRole("link", { name: /Refresh/ }).waitFor();
    assert.doesNotMatch(await page.locator(".time-block").innerText(), /starts in/);
    await page.clock.fastForward(9 * 60_000);
    await page.getByRole("button", { name: "Replace snapshot" }).click();
    await page.getByText(/since 14:30/).waitFor();
    assert.equal(await page.getByRole("link", { name: /Refresh/ }).count(), 0);
    const liveText = await page.locator(".time-block").innerText();
    assert.match(liveText, /^Live\b/);
    assert.match(liveText, / · 8 in the room/);
    assert.match(liveText, /America\/New_York · 19:30 UTC/);
    assert.equal((liveText.match(/America\/New_York/g) ?? []).length, 1);
    assert.match(liveText, /as of 14:30/);
    await page.clock.fastForward(60_000);
    await page.getByText(/live as of/).waitFor();
    assert.doesNotMatch(
      await page.locator(".time-block").innerText(),
      /^Live\b|since 14:30|8 in the room/,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
