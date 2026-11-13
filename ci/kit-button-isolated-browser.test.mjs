import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serveKitFixture } from "./kit-hydration-harness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "test/fixtures/kit-button-isolated.svelte");

test("button states work with hydration and without JavaScript", { timeout: 120000 }, async () => {
  const styles = ["vendor/design-kit/tokens.css", "web/src/ember-theme.css"]
    .map((path) => readFileSync(join(root, path), "utf8"))
    .join("\n");
  const destination = (_request, response) =>
    response.writeHead(200, { "content-type": "text/plain" }).end("Destination");
  const server = await serveKitFixture({
    fixture,
    styles,
    bodyClass: "base-theme",
    routes: { "/submitted": destination, "/e/raid": destination },
  });
  let browser;
  try {
    const url = server.url;
    assert.ok((await (await fetch(`${url}/style.css`)).text()).slice(styles.length).trim());
    browser = await chromium.launch();
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
    ]) {
      for (const javaScriptEnabled of [false, true]) {
        const context = await browser.newContext({ javaScriptEnabled, viewport });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          if (javaScriptEnabled) {
            await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
            await page.clock.pauseAt(new Date("2026-01-01T00:00:00Z"));
          }
          await page.goto(url);
          if (javaScriptEnabled) await page.waitForSelector('html[data-hydrated="true"]');
          const loading = page.getByRole("button", { name: "Saving…" });
          assert.equal(await loading.locator(".spinner").count(), 0);
          if (javaScriptEnabled) {
            await page.clock.fastForward(999);
            assert.equal(await loading.locator(".spinner").count(), 0);
            await page.clock.fastForward(1);
            assert.equal(await loading.locator(".spinner").count(), 1);
          }
          async function expectFocused(locator, visible = false) {
            assert.equal(
              await locator.evaluate(
                (el, checkVisible) =>
                  el === document.activeElement && (!checkVisible || el.matches(":focus-visible")),
                visible,
              ),
              true,
            );
          }
          await page.keyboard.press("Tab");
          await expectFocused(page.getByRole("button", { name: "Save event" }), true);
          await page.keyboard.press("Tab");
          await expectFocused(
            page.getByRole("button", { name: "Join Raid Night · Event is full" }),
          );
          for (const name of ["Join Raid Night · Event is full", "Saving…"]) {
            const action = page.getByRole("button", { name });
            assert.equal(await action.getAttribute("type"), "button");
            assert.equal(await action.getAttribute("aria-disabled"), "true");
            await action.click({ force: true });
            await action.focus();
            await page.keyboard.press("Enter");
            await page.keyboard.press("Space");
            assert.equal(page.url(), `${url}/`);
          }
          assert.equal(await page.getByTestId("activations").textContent(), "0");
          assert.equal(await page.getByTestId("submissions").textContent(), "0");
          for (const name of ["Reserve Raid Night · Event is full", "Opening…"]) {
            const link = page.getByRole("link", { name });
            assert.equal(await link.getAttribute("href"), null);
            await link.focus();
            if (name === "Opening…") await expectFocused(link);
            await page.keyboard.press("Enter");
            await link.click({ force: true });
            assert.equal(page.url(), `${url}/`);
          }
          const saved = page.locator("button.saved");
          await page.mouse.move(0, 0);
          await loading.focus();
          await page.keyboard.press("Tab");
          await expectFocused(saved, true);
          assert.equal(await saved.locator(".undo").isVisible(), true);
          await saved.blur();
          assert.equal(await saved.locator(".undo").isVisible(), false);
          await saved.hover();
          assert.equal(await saved.locator(".undo").isVisible(), true);
          const accent = page.getByRole("button", { name: "Continue" });
          assert.equal(
            await accent.evaluate(
              (el) =>
                el.classList.contains("on-accent") &&
                el.classList.contains("lg") &&
                el.classList.contains("full-width"),
            ),
            true,
          );
          assert.ok((await accent.boundingBox()).height >= 56);
          await saved.focus();
          await page.keyboard.press("Tab");
          await expectFocused(page.getByRole("link", { name: "Details for Raid Night" }));
          if (javaScriptEnabled) {
            await page.getByRole("button", { name: "Save event" }).click();
            assert.equal(await page.getByTestId("submissions").textContent(), "1");
          } else {
            await page.getByRole("button", { name: "Save event" }).click();
            await page.waitForURL((destination) => destination.pathname === "/submitted");
          }
          await page.goto(url);
          await page.getByRole("link", { name: "Details for Raid Night" }).click();
          await page.waitForURL("**/e/raid");
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await server.close();
    }
  }
});
