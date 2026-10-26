// Independent acceptance: real Hono/Kit SSR + local CSS; no DB or remote app.
// Discovered by the existing browser-smoke Playwright suite. Builder-owned UI
// screenshots/visual approvals remain separate from these behavioral checks.
import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import {
  createPrivacySectionFixture,
  POLICY_SECTION_TITLES,
  PRIVACY_NAV_ORIGIN,
} from "../test/helpers/privacy-section-fixture";

let fixture: Awaited<ReturnType<typeof createPrivacySectionFixture>>;
test.beforeAll(async () => {
  fixture = await createPrivacySectionFixture();
});
test.afterAll(() => {
  fixture?.close();
});

async function appearance(target: Locator) {
  return target.evaluate((element) => {
    const nodes = [element, ...element.querySelectorAll("*")].filter(
      (node): node is Element => node !== null,
    );
    return nodes.map((node) => {
      const style = getComputedStyle(node);
      return [
        style.backgroundColor,
        style.color,
        style.borderColor,
        style.outlineStyle,
        style.outlineWidth,
        style.outlineColor,
        style.boxShadow,
        style.fontWeight,
        style.textDecorationLine,
      ];
    });
  });
}

// No overlay (sticky chrome, skip link, focus ring) may cover the addressed
// heading: the topmost element at its reading point is itself or its content.
async function uncovered(target: Locator) {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
    const y = Math.min(
      Math.max(rect.top + Math.min(10, rect.height / 2), 1),
      window.innerHeight - 1,
    );
    const hit = document.elementFromPoint(x, y);
    return hit instanceof Element && (hit === element || element.contains(hit));
  });
}

for (const renderer of ["Hono", "Kit"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test.describe(`${renderer} privacy section links ${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport, javaScriptEnabled: false });
      test.beforeEach(async ({ context }) => {
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== PRIVACY_NAV_ORIGIN) return route.abort();
          if (url.pathname === "/privacy") {
            const { html, headers, status } = await fixture.render(renderer);
            return route.fulfill({
              status,
              headers: { ...headers, "content-type": "text/html; charset=utf-8" },
              body: html,
            });
          }
          // The content leaf CSS is inline in the real document. No invented
          // Tailwind/theme substitutes and no requests to external services.
          return route.abort();
        });
      });

      test("PRIVNAV-B01 copied direct hashes resolve every section without JS, unobscured", async ({
        page,
      }) => {
        await page.goto(`${PRIVACY_NAV_ORIGIN}/privacy`);
        const index = page.locator("nav", { has: page.locator('a[href^="#"]') });
        expect(await index.count(), "the server must render the jump navigation").toBe(1);
        const jumps = index.getByRole("link");
        expect(await jumps.count()).toBe(6);
        const ids = await jumps.evaluateAll((links) =>
          links.map((link) => new URL((link as HTMLAnchorElement).href).hash.slice(1)),
        );
        expect(new Set(ids).size).toBe(6);
        for (const [position, id] of ids.entries()) {
          expect(id).not.toBe("");
          expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
          const target = page.locator(`[id="${id}"]`);
          expect(await target.count()).toBe(1);
          // A new document load, not merely setting location.hash: this is the
          // member's copied URL opening in a no-JS browser.
          await page.goto("about:blank");
          await page.goto(`${PRIVACY_NAV_ORIGIN}/privacy#${id}`);
          await expect(target).toContainText(POLICY_SECTION_TITLES[position]!);
          await expect(target).toBeInViewport();
          if (position > 0)
            expect(
              await page.evaluate(() => window.scrollY),
              "fragment arrival must move to the section",
            ).toBeGreaterThan(0);
          expect(await uncovered(target), "the addressed section must not be covered").toBe(true);
          await page.goto(`${PRIVACY_NAV_ORIGIN}/privacy`);
        }
        await page.goto(`${PRIVACY_NAV_ORIGIN}/privacy#privacy-heading`);
        await expect(
          page.getByRole("heading", { level: 1, name: "Privacy policy", exact: true }),
        ).toBeInViewport();
      });

      test("PRIVNAV-B02 Tab reaches jump/permalink links, Enter works, and focused links stay visible", async ({
        page,
      }) => {
        await page.goto(`${PRIVACY_NAV_ORIGIN}/privacy`);
        const index = page.locator("nav", { has: page.locator('a[href^="#"]') });
        expect(await index.count()).toBe(1);
        const jump = index.getByRole("link", { name: "Deletion" });
        expect(await jump.count()).toBe(1);
        const href = await jump.getAttribute("href");
        expect(href).toMatch(/^#[A-Za-z][A-Za-z0-9_-]*$/);
        const resting = await appearance(jump);
        // Programmatic focus is not keyboard reachability: use the actual
        // document Tab sequence, with a bounded guard against focus traps.
        let reached = false;
        for (let tabs = 0; tabs < 50; tabs++) {
          await page.keyboard.press("Tab");
          reached = await jump.evaluate((element) => element === document.activeElement);
          if (reached) break;
        }
        expect(reached, "Tab must reach the native jump link").toBe(true);
        await expect(jump).toBeInViewport();
        expect(await appearance(jump), "keyboard focus must be visibly distinguished").not.toEqual(
          resting,
        );
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(`${PRIVACY_NAV_ORIGIN}/privacy${href}`);
        const target = page.locator(`[id="${href?.slice(1)}"]`);
        await expect(target).toBeInViewport();
        expect(await uncovered(target), "the jumped-to section must not be covered").toBe(true);
        const permalink = page.locator(
          `xpath=//div[@data-testid="privacy-policy"]//a[@href="${href}" and not(ancestor::nav)]`,
        );
        expect(await permalink.count()).toBe(1);
        await expect(permalink).toHaveAccessibleName(/Deletion/);
        // Reload resets sequential navigation. Prove the permalink itself is
        // tabbable rather than relying on anchor target focus behavior.
        await page.goto(`${PRIVACY_NAV_ORIGIN}/privacy`);
        reached = false;
        for (let tabs = 0; tabs < 60; tabs++) {
          await page.keyboard.press("Tab");
          reached = await permalink.evaluate((element) => element === document.activeElement);
          if (reached) break;
        }
        expect(reached, "Tab must reach the per-section permalink").toBe(true);
        await expect(permalink).toBeInViewport();
        const focus = await permalink.evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            (Number.parseFloat(style.outlineWidth) > 0 &&
              !["none", "hidden"].includes(style.outlineStyle)) ||
            style.boxShadow !== "none"
          );
        });
        expect(focus, "permalink has a visible keyboard focus indicator").toBe(true);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(`${PRIVACY_NAV_ORIGIN}/privacy${href}`);
        await expect(target).toBeInViewport();
      });

      test("PRIVNAV-B03 the compact jump list fits both viewports without clipping or overflow", async ({
        page,
      }) => {
        await page.goto(`${PRIVACY_NAV_ORIGIN}/privacy`);
        const index = page.locator("nav", { has: page.locator('a[href^="#"]') });
        expect(await index.count()).toBe(1);
        await expect(index).toBeVisible();
        const jumps = index.getByRole("link");
        expect(await jumps.count()).toBe(6);
        for (const title of POLICY_SECTION_TITLES) {
          const jump = index.getByRole("link", { name: title });
          expect(await jump.count()).toBe(1);
          await jump.focus();
          await expect(jump).toBeInViewport();
          const bounds = await jump.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        }
        const pageWidth = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          width: innerWidth,
        }));
        expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.width + 1);
      });

      test("PRIVNAV-B04 CONTROL retains copy, strap, history, actions and the heading hash without JS", async ({
        page,
      }) => {
        await page.goto(`${PRIVACY_NAV_ORIGIN}/privacy#privacy-heading`);
        await expect(
          page.getByRole("heading", { level: 1, name: "Privacy policy", exact: true }),
        ).toBeInViewport();
        const policy = page.locator('[data-testid="privacy-policy"]');
        const headings = policy.getByRole("heading", { level: 2 });
        expect(await headings.count()).toBe(6);
        for (const [position, title] of POLICY_SECTION_TITLES.entries())
          await expect(headings.nth(position)).toContainText(title);
        await expect(page.getByTestId("privacy-version")).toContainText("Version 6");
        await expect(
          page.getByRole("heading", { level: 2, name: "Previous published versions", exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId("privacy-join")).toHaveAttribute("href", "/join");
        await expect(
          page.getByRole("link", { name: "Back to the homepage", exact: true }),
        ).toHaveAttribute("href", "/");
        expect(await page.locator("script").count()).toBe(0);
      });
    });
  }
}
