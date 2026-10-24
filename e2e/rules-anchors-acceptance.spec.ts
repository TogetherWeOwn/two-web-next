// Independent acceptance: real Hono/Kit SSR + local CSS; no DB or remote app.
// Discovered by the existing browser-smoke Playwright suite. Builder-owned UI
// screenshots/visual approvals remain separate from these behavioral checks.
import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";
import {
  changedRuleRows,
  createRulesFixture,
  LONG_RULE_LABEL,
  RULE_COPY,
  RULE_ORIGIN,
} from "../test/helpers/rules-anchor-fixture";

let fixture: Awaited<ReturnType<typeof createRulesFixture>>;
test.beforeAll(async () => {
  fixture = await createRulesFixture();
});
test.afterAll(() => {
  fixture?.close();
});

async function appearance(target: Locator) {
  return target.evaluate((element) => {
    const nodes = [element, element.closest("li"), ...element.querySelectorAll("*")].filter(
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

for (const renderer of ["Hono", "Kit"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test.describe(`${renderer} native rule links ${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport, javaScriptEnabled: false });
      test.beforeEach(async ({ context }) => {
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== RULE_ORIGIN) return route.abort();
          if (url.pathname === "/rules") {
            const rows = url.searchParams.has("long") ? changedRuleRows() : undefined;
            const { html, headers, status } = await fixture.render(renderer, rows);
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

      test("RULE-B01 copied direct hashes resolve every rule without JS and distinguish the target", async ({
        page,
      }) => {
        await page.goto(`${RULE_ORIGIN}/rules`);
        const index = page.getByRole("navigation", { name: "Jump to a rule", exact: true });
        expect(await index.count(), "the server must render the jump navigation").toBe(1);
        const jumps = index.getByRole("link");
        expect(await jumps.count()).toBe(5);
        const ids = await jumps.evaluateAll((links) =>
          links.map((link) => new URL((link as HTMLAnchorElement).href).hash.slice(1)),
        );
        expect(new Set(ids).size).toBe(5);
        for (const [position, id] of ids.entries()) {
          expect(id).not.toBe("");
          const target = page.locator(`[id="${id}"]`);
          expect(await target.count()).toBe(1);
          const neutral = await appearance(target);
          // A new document load, not merely setting location.hash: this is the
          // moderator's copied URL opening in a no-JS browser.
          await page.goto("about:blank");
          await page.goto(`${RULE_ORIGIN}/rules#${id}`);
          await expect(target).toBeInViewport();
          await expect(target.locator("xpath=ancestor-or-self::li")).toContainText(
            RULE_COPY[position]![0],
          );
          const item = target.locator("xpath=ancestor-or-self::li");
          // --surface resolves to #222430 (public/theme.css .base-theme); the
          // addressed card must paint it, not the .card reset transparent bg.
          await expect(item).toHaveCSS("background-color", "rgb(34, 36, 48)");
          expect(
            await appearance(target),
            "the addressed rule needs a visible target treatment",
          ).not.toEqual(neutral);
          await page.goto(`${RULE_ORIGIN}/rules`);
        }
        await page.goto(`${RULE_ORIGIN}/rules#rules-heading`);
        await expect(
          page.getByRole("heading", { level: 1, name: "House rules", exact: true }),
        ).toBeInViewport();
      });

      test("RULE-B02 Tab reaches jump/permalink links, Enter works, and focused links stay visible", async ({
        page,
      }) => {
        await page.goto(`${RULE_ORIGIN}/rules`);
        const index = page.getByRole("navigation", { name: "Jump to a rule", exact: true });
        expect(await index.count()).toBe(1);
        const jump = index.getByRole("link", { name: "Respect the room", exact: true });
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
        await expect(page).toHaveURL(`${RULE_ORIGIN}/rules${href}`);
        const target = page.locator(`[id="${href?.slice(1)}"]`);
        await expect(target).toBeInViewport();
        const item = target.locator("xpath=ancestor-or-self::li");
        const permalink = item.locator(`a[href="${href}"]`);
        expect(await permalink.count()).toBe(1);
        await expect(permalink).toHaveAccessibleName(/Respect the room/);
        // Reload resets sequential navigation. Prove the permalink itself is
        // tabbable rather than relying on anchor target focus behavior.
        await page.goto(`${RULE_ORIGIN}/rules`);
        reached = false;
        for (let tabs = 0; tabs < 60; tabs++) {
          await page.keyboard.press("Tab");
          reached = await permalink.evaluate((element) => element === document.activeElement);
          if (reached) break;
        }
        expect(reached, "Tab must reach the per-rule permalink").toBe(true);
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
        await expect(page).toHaveURL(`${RULE_ORIGIN}/rules${href}`);
        await expect(target).toBeInViewport();
      });

      test("RULE-B03 long shared labels wrap without horizontal overflow or clipped focus", async ({
        page,
      }) => {
        await page.goto(`${RULE_ORIGIN}/rules?long=1`);
        const index = page.getByRole("navigation", { name: "Jump to a rule", exact: true });
        expect(await index.count()).toBe(1);
        const jump = index.getByRole("link", { name: LONG_RULE_LABEL, exact: true });
        expect(await jump.count()).toBe(1);
        await jump.focus();
        await expect(jump).toBeInViewport();
        const bounds = await jump.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        const pageWidth = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          width: innerWidth,
        }));
        expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.width + 1);
        if (viewport.width === 390) {
          const lines = await jump.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return new Set([...range.getClientRects()].map((rect) => Math.round(rect.y))).size;
          });
          expect(lines, "long mobile labels wrap instead of clipping").toBeGreaterThan(1);
        }
        await page.keyboard.press("Enter");
        const href = await jump.getAttribute("href");
        await expect(page).toHaveURL(`${RULE_ORIGIN}/rules?long=1${href}`);
        await expect(page.locator(`[id="${href?.slice(1)}"]`)).toBeInViewport();
      });

      test("RULE-B04 CONTROL retains no-JS policy, stamp, actions and the existing heading hash", async ({
        page,
      }) => {
        await page.goto(`${RULE_ORIGIN}/rules#rules-heading`);
        await expect(
          page.getByRole("heading", { level: 1, name: "House rules", exact: true }),
        ).toBeInViewport();
        const list = page.locator('ol[data-testid="rules-list"]');
        await expect(list.locator(":scope > li")).toHaveCount(5);
        for (const [position, [title, body]] of RULE_COPY.entries()) {
          const row = list.locator(":scope > li").nth(position);
          await expect(row.getByRole("heading", { level: 2 })).toContainText(title);
          await expect(row.locator("p")).toHaveText(body);
        }
        await expect(page.locator('[data-testid="rules-last-updated"] time')).toHaveAttribute(
          "datetime",
          "2026-09-01",
        );
        await expect(page.getByTestId("rules-join")).toHaveAttribute("href", "/join");
        await expect(
          page.getByRole("link", { name: "Back to the homepage", exact: true }),
        ).toHaveAttribute("href", "/");
        expect(await page.locator("script").count()).toBe(0);
      });
    });
  }
}
