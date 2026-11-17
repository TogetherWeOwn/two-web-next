import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { serveKitFixture } from "./kit-hydration-harness.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "test/fixtures/kit-button-isolated.svelte");

test("button states work with hydration and without JavaScript", { timeout: 120000 }, async () => {
  const { compile } = createRequire(join(root, "web/package.json"))("@tailwindcss/node");
  const appCss = join(root, "web/src/app.css");
  const compiled = await compile(readFileSync(appCss, "utf8"), { base: join(root, "web/src") });
  const styles = `${compiled.build([])}\nbody { background: var(--g0); color: var(--t1); }\n`;
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
    assert.ok((await (await fetch(`${server.url}/style.css`)).text()).slice(styles.length).trim());
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
          const screenshot = (state) =>
            page.screenshot({ path: `artifacts/kit-button/${viewport.width}-${state}.png` });
          page.on("pageerror", (error) => errors.push(error.message));
          if (javaScriptEnabled) {
            await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
            await page.clock.pauseAt(new Date("2026-01-01T00:00:00Z"));
          }
          await page.goto(server.url);
          if (javaScriptEnabled) await page.waitForSelector('html[data-hydrated="true"]');
          const loading = page.getByRole("button", { name: "Saving…" });
          assert.equal(await loading.locator(".spinner").count(), 0);
          if (javaScriptEnabled) {
            await page.clock.fastForward(999);
            assert.equal(await loading.locator(".spinner").count(), 0);
            await page.clock.fastForward(1);
            assert.equal(await loading.locator(".spinner").count(), 1);
            await page.clock.resume();
          }
          async function expectFocused(locator, visible = false) {
            assert.equal(await locator.evaluate((el) => el === document.activeElement), true);
            if (visible)
              assert.equal(await locator.evaluate((el) => el.matches(":focus-visible")), true);
          }
          const primary = page.getByRole("button", { name: "Save event" });
          const geometry = await primary.evaluate((el) => {
            const css = getComputedStyle(el);
            return [css.borderRadius, css.paddingInlineStart];
          });
          assert.deepEqual(geometry, ["999px", "20px"]);
          await page.keyboard.press("Tab");
          await expectFocused(primary, true);
          if (javaScriptEnabled) {
            await screenshot("focus");
            const { violations } = await new AxeBuilder({ page }).include("body").analyze();
            assert.deepEqual(
              violations.filter(({ impact }) => ["critical", "serious"].includes(impact)),
              [],
            );
          }
          const fullEvent = "Join Raid Night · Event is full";
          await page.keyboard.press("Tab");
          await expectFocused(page.getByRole("button", { name: fullEvent }));
          for (const name of [fullEvent, "Saving…"]) {
            const action = page.getByRole("button", { name });
            assert.equal(await action.getAttribute("type"), "button");
            assert.equal(await action.getAttribute("aria-disabled"), "true");
            await action.click({ force: true });
            await action.focus();
            await page.keyboard.press("Enter");
            await page.keyboard.press("Space");
            assert.equal(page.url(), `${server.url}/`);
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
            assert.equal(page.url(), `${server.url}/`);
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
          if (javaScriptEnabled) await screenshot("hover");
          const accent = page.getByRole("button", { name: "Continue" });
          assert.equal(await accent.evaluate((el) => el.matches(".on-accent.lg.full-width")), true);
          assert.ok((await accent.boundingBox()).height >= 56);
          await page.getByRole("link", { name: "Opening…" }).focus();
          await page.keyboard.press("Tab");
          await expectFocused(accent, true);
          assert.equal(
            await accent.evaluate((el) => getComputedStyle(el).outlineColor),
            "rgb(29, 11, 0)",
          );
          if (javaScriptEnabled) await screenshot("accent-focus");
          await saved.focus();
          await page.keyboard.press("Tab");
          await expectFocused(page.getByRole("link", { name: "Details for Raid Night" }));
          await primary.click();
          if (javaScriptEnabled) {
            assert.equal(await page.getByTestId("submissions").textContent(), "1");
          } else {
            await page.waitForURL((destination) => destination.pathname === "/submitted");
          }
          await page.goto(server.url);
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
