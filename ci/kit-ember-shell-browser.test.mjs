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

const desktop = { width: 1280, height: 800 };
const headerCss = "/kit-site-header.css";

async function assertLockup(page, height) {
  const logo = page.locator("[data-kit-site-header] .brand img:visible");
  await expect(logo).toHaveCount(1);
  await expect(logo).toHaveAttribute("src", "/logo.svg");
  await expect(logo).toHaveCSS("height", `${height}px`);
  const { width, loaded } = await logo.evaluate((img) => ({
    width: img.getBoundingClientRect().width,
    loaded: img.complete && img.naturalWidth > 0,
  }));
  assert.ok(loaded, "full lockup image loaded");
  if (height === 50) assert.equal(width, 180);
  else assert.ok(Math.abs(width - (height * 180) / 50) < 1, `full lockup width: ${width}px`);
}

async function checkStandaloneHeader(page, html) {
  // Closing the fallback menu leaves #kit-menu in the URL; use a distinct
  // query so this navigation cannot reuse the document via its fragment.
  const standaloneUrl = new URL("?standalone-header=1", page.url()).href;
  const assets = ["/styles.css", "/theme-tokens.css", headerCss, "/theme.css"];
  // Keep the built SSR markup, with only public stylesheets and the legacy
  // theme last. Neither the root bundle nor source order can hide a cascade tie.
  const standalone = html.replace(
    /<head>[\s\S]*?<\/head>/,
    `<head><meta name="viewport" content="width=device-width, initial-scale=1">${assets
      .map((name) => `<link rel="stylesheet" href="${name}">`)
      .join("")}</head>`,
  );
  assert.notEqual(standalone, html);
  assert.doesNotMatch(standalone, /_app\/immutable\//);
  await page.route(standaloneUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "content-security-policy": "style-src 'self'; script-src 'none'" },
      body: standalone,
    }),
  );
  try {
    await page.setViewportSize(desktop);
    const [css] = await Promise.all([
      page.waitForResponse(new URL(headerCss, standaloneUrl).href),
      page.goto(standaloneUrl),
    ]);
    assert.equal(css.status(), 200);
    assert.match(css.headers()["content-type"], /^text\/css\b/);
    await assertLockup(page, 50);
    await shot(page, "standalone-desktop-1280");
    await page.setViewportSize(mobile);
    await assertLockup(page, 32);
    await shot(page, "standalone-mobile-390");
    await menu(page, "link").click();
    await expect(page.getByRole("link", { name: "Close menu" })).toBeVisible();
    await assertLockup(page, 32);
    await shot(page, "standalone-mobile-open-390");
  } finally {
    await page.unroute(standaloneUrl);
  }
}

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
        for (const viewport of [desktop, mobile]) {
          await page.setViewportSize(viewport);
          const header = page.getByRole("banner");
          const compact = viewport === mobile;
          await assertLockup(page, compact ? 32 : 38);
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
        if (state === "guest") await checkStandaloneHeader(page, html);
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
    const header = page.getByRole("banner");
    const canvas = await header.evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    const brand = header.getByRole("link", { name: "Together We Own homepage" });
    await expect(brand).toHaveCSS("forced-color-adjust", "auto");
    await expect(brand.locator("img")).toHaveCSS("background-color", canvas);
    await toggle.press("Space");
    await toggle.press("Space");
    await expect(home).toHaveCSS("outline-style", "solid");
    await expect(sheet).toHaveCSS("animation-name", "none");
    await shot(page, "forced-colors-open-390");

    // Playwright viewport widths are integers; pin the exact CSS complement too.
    const css = await readFile(new URL("../web/src/lib/ember-header.css", import.meta.url), "utf8");
    assert.match(css, /@media not all and \(max-width: 820px\)/);
    await open("?state=guest");
    const join = header.getByRole("link", { name: "Join", exact: true });
    for (const width of [820, 821]) {
      await page.setViewportSize({ ...mobile, width });
      await expect(join).toHaveCount(1);
      await expect(menu(page)).toHaveCount(Number(width === 820));
    }
    await page.setViewportSize(mobile);
    await brand.focus();
    await page.keyboard.press("Tab");
    await expect(join).toBeFocused();
    await expect(join).toHaveCSS("outline-style", "solid");
    await shot(page, "forced-colors-guest-390");

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

    // Home uses the same marker on its own header, without the fragment target.
    const markedHeader = page.locator("header[data-kit-site-header]");
    await markedHeader.evaluate((header) => {
      header.removeAttribute("id");
      header.removeAttribute("class");
    });
    await expect(markedHeader).toHaveCSS("position", "sticky");
    await expect(markedHeader).toHaveCSS("padding-inline-start", "0px");
    await expect(markedHeader).toHaveCSS("z-index", "1");
  });
});
