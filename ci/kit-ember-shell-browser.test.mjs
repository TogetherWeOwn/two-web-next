import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { withKitOfflineBrowser } from "./kit-offline-browser.mjs";

const mobile = { width: 390, height: 844 };
const member = "?state=member&auth=1";
const menu = (page, role = "button") => page.getByRole(role, { name: "Menu", exact: true });
const shot = (page, name) =>
  page.screenshot({ path: `artifacts/kit-ember-shell/${name}.png`, animations: "disabled" });
const route = new URL("../test/fixtures/kit-ember-shell-route.svelte", import.meta.url);
const source = await readFile(route, "utf8");

test("built Ember shell preserves its landmarks and account states without JavaScript", {
  timeout: 720_000,
}, async () => {
  await mkdir("artifacts/kit-ember-shell", { recursive: true });
  for (const state of ["guest", "member", "hidden"]) {
    await withKitOfflineBrowser(
      { page: source, search: state === "member" ? member : `?state=${state}` },
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
          await page.getByRole("link", { name: "Ladder" }).count(),
          state === "member" ? 1 : 0,
        );
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          const header = page.getByRole("banner");
          const compact = viewport.width === 390;
          await expect(header).toHaveCSS("min-height", compact ? "60px" : "68px");
          await expect(header).toHaveCSS("position", "sticky");
          await expect(header.getByRole("link", { name: "Join", exact: true })).toHaveCount(
            Number(state === "guest"),
          );
          await expect(header.getByText(/online/i)).toHaveCount(0);
          if (!compact) {
            const primary = header.getByRole("navigation", { name: "Primary" });
            await expect(primary.getByRole("link")).toHaveText(
              state === "member" ? ["Events", "Ladder", "About"] : ["Events", "About"],
            );
          }
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.equal(
            await page
              .getByRole("navigation", { name: "Footer" })
              .evaluate((nav) => getComputedStyle(nav).marginTop),
            "0px",
          );
          const edges = await page.evaluate(() => {
            const main = document.querySelector("main");
            const footerContent = document.querySelector(".footer-content");
            const brand = document.querySelector(".menu-brand");
            return [
              main.getBoundingClientRect().left + parseFloat(getComputedStyle(main).paddingLeft),
              footerContent.getBoundingClientRect().left,
              brand.getBoundingClientRect().left,
            ];
          });
          assert.deepEqual(edges, compact ? [20, 20, 20] : [60, 60, 60]);
          await page.screenshot({
            path: `artifacts/kit-ember-shell/${state}-${viewport.width}.png`,
            fullPage: true,
          });
          if (state === "guest") {
            await page.keyboard.press("Tab");
            assert.equal(
              await page
                .locator('a[href="#main"]')
                .evaluate((link) => link === document.activeElement),
              true,
            );
            await page.screenshot({
              path: `artifacts/kit-ember-shell/skip-focused-${viewport.width}.png`,
              fullPage: true,
            });
            await page.reload();
          }
          const fallback = menu(page, "link");
          const sheet = page.locator(".menu-sheet");
          if (viewport.width === 390) {
            await expect(sheet).toBeHidden();
            assert.equal(await fallback.getAttribute("aria-expanded"), null);
            await fallback.click();
            const account = sheet.getByRole("navigation", { name: "Account" });
            const link = (name) => sheet.getByRole("link", { name });
            await expect(account).toHaveCount(Number(state !== "hidden"));
            await expect(link("Profile")).toHaveCount(Number(state === "member"));
            await expect(link("Sign in with Discord")).toHaveCount(Number(state === "guest"));
            await expect(sheet.getByRole("link", { name: "Join", exact: true })).toHaveCount(
              Number(state === "guest"),
            );
            await expect(link("Ladder")).toHaveCount(Number(state === "member"));
            await expect(page.locator("[inert]")).toHaveCount(0);
            if (state !== "hidden") await expect(account).toHaveCSS("justify-self", "stretch");
            await shot(page, `nojs-${state}-open-390`);
            const close = link("Close menu");
            const about = page
              .getByRole("navigation", { name: "Footer" })
              .getByRole("link", { name: "About", exact: true });
            await close.focus();
            for (const target of [about, close, about]) {
              await page.keyboard.press(target === close ? "Shift+Tab" : "Tab");
              await expect(target).toBeFocused();
            }
            await expect(sheet.locator("..")).toHaveCSS("position", "static");
          }
          if (state === "member") {
            const button = page.getByTestId(viewport.width === 390 ? "menu-signout" : "signout");
            const location = page.url();
            const logout = new URL("/logout", location).href;
            await page.route(logout, (route) => route.fulfill({ body: "OK" }), { times: 1 });
            const [post] = await Promise.all([page.waitForRequest(logout), button.click()]);
            assert.equal(post.method(), "POST");
            await page.goto(location);
          }
          if (viewport.width === 390) {
            await sheet.getByRole("link", { name: "Close menu" }).click();
            await expect(sheet).toBeHidden();
          }
        }
      },
    );
  }
});

test("CSR-disabled Kit header supports keyboard, account variants, and a blocked island", {
  timeout: 720_000,
}, async () => {
  const states = [
    ["guest", "?state=guest", 0, "page"],
    ["member", member, 1, "location"],
    ["nonmember", "?auth=1", 1, "page"],
    ["unknown", "?state=member", 0, "location"],
    ["hidden", "?state=hidden&auth=1", 0, "page"],
  ];
  const searches = states.map(([, search]) => search);
  const options = { page: source, javaScriptEnabled: true, headerMenu: true, searches };
  await withKitOfflineBrowser(options, async ({ page, html, open }) => {
    const url = page.url();
    const toggle = menu(page);
    const sheet = page.locator(".menu-sheet");
    const row = (name, role = "link") => sheet.getByRole(role, { name, exact: true });
    const home = row("Home");
    const inert = page.locator("main[inert], footer[inert]");
    assert.match(html, /<script src="\/islands\/site-header-menu\.js" defer>/);
    assert.doesNotMatch(html, /_app\/immutable\/(entry|nodes)/);
    await page.setViewportSize(mobile);
    await toggle.focus();
    await shot(page, "enhanced-closed-390");
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      assert.equal(await sheet.locator(":focus").count(), 0);
    }
    await toggle.click();
    await expect(home).toBeFocused();
    await expect(inert).toHaveCount(2);
    await expect(sheet.getByText("Close menu")).toBeHidden();
    await shot(page, "keyboard-open-390");
    await expect(row("Sign in with Discord")).toHaveCSS("justify-content", "flex-start");
    for (const [i, target] of [toggle, row("Join"), toggle, home].entries()) {
      await page.keyboard.press(i < 2 ? "Shift+Tab" : "Tab");
      await expect(target).toBeFocused();
    }
    const axe = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
    assert.deepEqual((await axe.analyze()).violations, []);
    for (const close of [() => page.keyboard.press("Escape"), () => toggle.press("Enter")]) {
      await close();
      await expect(toggle).toBeFocused();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(inert).toHaveCount(0);
      await toggle.press("Space");
    }
    await home.evaluate((el) => el.addEventListener("click", (event) => event.preventDefault()));
    await home.click();
    await expect(sheet).toBeHidden();
    await expect(toggle).not.toBeFocused();
    for (const start of [home, toggle]) {
      await page.setViewportSize({ ...mobile, width: 820 });
      await page.goto(`${url}${member}#menu-sheet`);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      if (start === toggle) await page.keyboard.press("Shift+Tab");
      await expect(start).toBeFocused();
      await page.setViewportSize({ ...mobile, width: 821 });
      await expect(inert).toHaveCount(0);
      await expect(row("Events")).toBeFocused();
    }
    await page.setViewportSize({ ...mobile, width: 320 });
    await expect(toggle).toBeFocused();
    await toggle.click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot(page, "enhanced-open-320");
    await page.setViewportSize(mobile);
    for (const [name, search, count, current] of states) {
      await open(search);
      await toggle.click();
      await expect(row("Profile")).toHaveCount(Number(name === "member"));
      await expect(row("Sign out", "button")).toHaveCount(count);
      await expect(sheet.locator("[aria-current]")).toHaveAttribute("aria-current", current);
      await expect(row("Ladder")).toHaveCount(Number(current === "location"));
      await expect(row("Account", "navigation")).toHaveCount(Number(name !== "hidden"));
      await shot(page, `${name}-menu-open-390`);
    }
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await toggle.press("Space");
    await toggle.press("Space");
    await expect(home).toHaveCSS("outline-style", "solid");
    await expect(sheet).toHaveCSS("animation-name", "none");
    await shot(page, "forced-colors-open-390");
    const island = new URL("/islands/site-header-menu.js", url).href;
    await page.route(island, (route) => route.abort());
    async function assertFallback(name) {
      const trigger = menu(page, "link");
      assert.equal(await trigger.getAttribute("aria-expanded"), null);
      await trigger.click();
      await expect(page).toHaveURL(/#menu-sheet$/);
      await expect(row("Close menu")).toBeVisible();
      await expect(inert).toHaveCount(0);
      await shot(page, `${name}-open-390`);
    }
    await open("?state=guest");
    await assertFallback("blocked-island");
    await page.unroute(island);
    await page.addInitScript(() => Reflect.deleteProperty(HTMLElement.prototype, "inert"));
    const [response] = await Promise.all([page.waitForResponse(island), open("?state=guest")]);
    assert.equal(response.ok(), true);
    assert.equal(await page.evaluate(() => "inert" in HTMLElement.prototype), false);
    await assertFallback("no-inert");
  });
});
