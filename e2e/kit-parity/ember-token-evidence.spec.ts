import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { HONO_ORIGIN, KIT_ORIGIN, PARITY_VIEWPORTS } from "../kit-parity";
import { withKitOfflineBrowser } from "../../ci/kit-offline-browser.mjs";

// Real-app viewport evidence, not visual-regression baseline acceptance.
// CI runs this read-only capture before journeys mutate the disposable seed.
const targets = [
  { name: "hono", origin: HONO_ORIGIN, path: "/" },
  { name: "kit", origin: KIT_ORIGIN, path: "/events/past" },
] as const;
const states = ["default", "reduced-motion", "forced-colors", "keyboard-focus"] as const;

// The row has no production consumer yet. Render the actual component in a
// disposable Kit route; this capture does not claim consumer-page parity.
test("captures structured-time row states in Kit without JavaScript", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withKitOfflineBrowser(
    {
      page: `<script>import StructuredTime from '#lib/StructuredTime.svelte';</script>
<StructuredTime state="upcoming" startsAt="2026-12-01T19:00:00Z" zone="America/New_York" />
<StructuredTime state="past" startsAt="2026-12-01T19:00:00Z" endsAt="2026-12-01T20:00:00Z" zone="UTC" />
<StructuredTime state="cancelled" startsAt="2026-12-01T19:00:00Z" zone="UTC" />
<StructuredTime state="upcoming" startsAt={null} />`,
    },
    async ({ page }: { page: any }) => {
      const rows = page.locator(".row-time");
      await expect(rows).toHaveCount(4);
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        const accessibility = await new AxeBuilder({ page }).include(".row-time").analyze();
        expect(accessibility.violations).toEqual([]);
        await page.screenshot({
          path: testInfo.outputPath(`ember-structured-time-${viewport.width}.png`),
          fullPage: false,
        });
      }
    },
  );
});

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
