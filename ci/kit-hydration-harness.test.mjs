import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { bundleKitFixture, serveKitFixture } from "./kit-hydration-harness.mjs";

test("fixture compiler returns independent server and client bundles", async () => {
  const fixture = fileURLToPath(
    new URL("../test/fixtures/kit-browser-harness.svelte", import.meta.url),
  );
  const source = `import Fixture from ${JSON.stringify(fixture)}; export default Fixture;`;
  const server = await bundleKitFixture("server", source);
  const client = await bundleKitFixture("client", source);
  assert.match(server.code, /Café fixture/);
  assert.equal(server.css, "");
  assert.match(client.code, /Café fixture/);
  assert.match(client.css, /12,\s*34,\s*56/);
});

test("fixture serves SSR, hydrates, styles and closes", { timeout: 120000 }, async () => {
  const fixture = fileURLToPath(
    new URL("../test/fixtures/kit-browser-harness.svelte", import.meta.url),
  );
  const server = await serveKitFixture({ fixture });
  let browser;
  try {
    const response = await fetch(server.url);
    assert.match(response.headers.get("content-type"), /charset=utf-8/);
    const html = await response.text();
    assert.match(html, /Count: 0/);
    assert.match(html, /<title>Café fixture<\/title>/);
    assert.equal((await fetch(`${server.url}/missing`)).status, 404);
    browser = await chromium.launch();
    for (const javaScriptEnabled of [false, true]) {
      const context = await browser.newContext({ javaScriptEnabled });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(server.url);
        assert.equal(await page.title(), "Café fixture");
        if (javaScriptEnabled) await page.waitForSelector('html[data-hydrated="true"]');
        const button = page.getByRole("button", { name: "Count: 0" });
        assert.equal(
          await button.evaluate((element) => getComputedStyle(element).color),
          "rgb(12, 34, 56)",
        );
        await button.click();
        assert.equal(
          await page.locator("button").textContent(),
          javaScriptEnabled ? "Count: 1" : "Count: 0",
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await server.close();
    }
  }
  await assert.rejects(fetch(server.url));
});
