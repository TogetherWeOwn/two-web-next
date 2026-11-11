import { writeFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { HONO_ORIGIN, KIT_ORIGIN, PARITY_VIEWPORTS } from "../kit-parity";

// Real-app viewport evidence, not visual-regression baseline acceptance.
// CI runs this read-only capture before journeys mutate the disposable seed.
const targets = [
  { name: "hono", origin: HONO_ORIGIN, path: "/" },
  { name: "kit", origin: KIT_ORIGIN, path: "/events/past" },
] as const;
const states = ["default", "reduced-motion", "forced-colors", "keyboard-focus"] as const;

for (const target of targets) {
  for (const viewport of PARITY_VIEWPORTS) {
    for (const state of states) {
      test.describe(`ember evidence: ${target.name} ${viewport.name} ${state}`, () => {
        test.use({
          viewport: viewport.size,
          reducedMotion: state === "reduced-motion" ? "reduce" : "no-preference",
          forcedColors: state === "forced-colors" ? "active" : "none",
        });

        test("renders the pinned UI and captures the viewport", async ({ page }, testInfo) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.route("**/*", (route) => {
            const origin = new URL(route.request().url()).origin;
            return origin === HONO_ORIGIN || origin === KIT_ORIGIN
              ? route.continue()
              : route.abort("blockedbyclient");
          });
          const response = await page.goto(`${target.origin}${target.path}`);
          expect(response?.status()).toBe(200);
          if (target.name === "kit") {
            expect(response?.headers()["x-two-renderer"]).toBe("kit");
            await expect(page.getByTestId("past-events")).toBeVisible();
            await expect(page.getByText("E2E Past Night", { exact: true })).toBeVisible();
          } else {
            await expect(page.locator("#home-heading")).toBeVisible();
          }
          await page.evaluate(() => (globalThis as any).document.fonts.ready);

          if (state === "keyboard-focus") {
            await page.keyboard.press("Tab");
            await expect(page.locator(".skip-link")).toBeFocused();
            await expect(page.locator(".skip-link")).toBeVisible();
          }
          const metrics = await page.locator(".base-theme").evaluate((shell: any) => {
            const browser = globalThis as any;
            const style = browser.getComputedStyle(shell);
            const focus = browser.getComputedStyle(browser.document.activeElement);
            return {
              fontFamily: style.fontFamily,
              fontSize: style.fontSize,
              lineHeight: style.lineHeight,
              // Probe the role consumed by shared button transitions, not an unused alias.
              motionBase: Number.parseFloat(style.getPropertyValue("--motion-duration-base")),
              overflow: browser.document.documentElement.scrollWidth > browser.innerWidth,
              outlineWidth: focus.outlineWidth,
              outlineOffset: focus.outlineOffset,
            };
          });
          expect(metrics.fontFamily).toContain("Mona Sans");
          expect(metrics.fontSize).toBe("16px");
          expect(metrics.lineHeight).toBe("24.8px");
          expect(metrics.overflow).toBe(false);
          if (state === "reduced-motion") expect(metrics.motionBase).toBe(0);
          else expect(metrics.motionBase).toBeGreaterThan(0);
          if (state === "keyboard-focus") {
            expect(metrics.outlineWidth).toBe("2px");
            expect(metrics.outlineOffset).toBe("3px");
          }
          expect(pageErrors).toEqual([]);

          const name = `ember-${target.name}-${viewport.size.width}-${state}`;
          await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false });
          const receipt = {
            sha: process.env.GITHUB_SHA,
            path: target.path,
            viewport: viewport.size,
            state,
            metrics,
          };
          writeFileSync(
            testInfo.outputPath(`${name}.json`),
            `${JSON.stringify(receipt, null, 2)}\n`,
          );
        });
      });
    }
  }
}
