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
  { name: "kit-home", origin: KIT_ORIGIN, path: "/", cta: ".hero-action .btn" },
  { name: "kit-events", origin: KIT_ORIGIN, path: "/events", cta: ".ember-header-join:visible" },
  { name: "kit-join", origin: KIT_ORIGIN, path: "/join", cta: ".join-primary" },
] as const;
const states = ["default", "reduced-motion", "forced-colors", "keyboard-focus"] as const;

// The row has no production consumer yet. Render the actual component in a
// disposable Kit route; this capture does not claim consumer-page parity.
test("captures structured-time row states in Kit without JavaScript", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = `<script>import StructuredTime from '#lib/StructuredTime.svelte';</script>
<div class="base-theme">
<StructuredTime state="upcoming" startsAt="2026-12-01T19:00:00Z" zone="America/New_York" />
<StructuredTime state="past" startsAt="2026-12-01T19:00:00Z" endsAt="2026-12-01T20:00:00Z" zone="UTC" />
<StructuredTime state="cancelled" startsAt="2026-12-01T19:00:00Z" zone="UTC" />
<StructuredTime state="upcoming" startsAt={null} />
</div>`;
  const viewports = [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ];
  await withKitOfflineBrowser(
    { source: process.cwd(), page: fixture },
    async ({ page }: { page: any }) => {
      await expect(page.locator(".row-time")).toHaveCount(4);
      await expect(page.locator(".row-time .line1").first()).toHaveCSS(
        "color",
        "rgb(246, 241, 234)",
      );
      await expect(page.locator(".row-time .line2").first()).toHaveCSS(
        "color",
        "rgb(168, 154, 142)",
      );
      await expect(page.locator(".row-time").first()).toHaveCSS("row-gap", "4px");
      await expect(page.locator(".row-time .line1").first()).toHaveCSS("font-size", "15px");
      await expect(page.locator(".row-time .word")).toHaveCSS("font-weight", "600");
      await expect(page.locator(".row-time .word")).toHaveCSS("margin-left", "8px");
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await page.screenshot({
          path: testInfo.outputPath(`ember-structured-time-${viewport.width}.png`),
          fullPage: false,
        });
      }
    },
  );
  // Axe injects scripts, so run it in a separate JavaScript-enabled context.
  await withKitOfflineBrowser(
    { source: process.cwd(), page: fixture, javaScriptEnabled: true },
    async ({ page }: { page: any }) => {
      await expect(page.locator(".row-time")).toHaveCount(4);
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        const accessibility = await new AxeBuilder({ page }).include(".row-time").analyze();
        expect(accessibility.violations).toEqual([]);
      }
    },
  );
});

test("Kit join reflows at 320px and has no accessibility violations", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === KIT_ORIGIN
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  const response = await page.goto(`${KIT_ORIGIN}/join`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-two-renderer"]).toBe("kit");
  await expect(page.getByTestId("join-oneclick")).toBeVisible();
  const overflow = await page.evaluate("document.documentElement.scrollWidth > window.innerWidth");
  expect(overflow).toBe(false);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
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
          } else if (target.name === "kit-join") {
            expect(response?.headers()["x-two-renderer"]).toBe("kit");
            await expect(
              page.getByRole("heading", { level: 1, name: "Play with people who show up." }),
            ).toBeVisible();
            await expect(page.getByTestId("join-oneclick")).toBeVisible();
          } else if (target.name === "kit-events") {
            await expect(page.locator("#events-heading")).toBeVisible();
          } else {
            await expect(page.locator("#home-heading")).toBeVisible();
          }
          if ("cta" in target) {
            expect(response?.headers()["x-two-renderer"]).toBe("kit");
            const shell = page.locator(".base-theme");
            const cta = page.locator(target.cta);
            await expect(cta).toBeVisible();
            if (state === "forced-colors") {
              await expect(shell).toHaveCSS("background-image", "none");
              await expect(cta).toHaveCSS("background-image", "none");
            } else {
              await expect(shell).toHaveCSS("background-color", "rgb(21, 16, 15)");
              await expect(shell).toHaveCSS("background-image", /^radial-gradient\(/);
              await expect(cta).toHaveCSS(
                "background-image",
                "linear-gradient(135deg, rgb(255, 170, 71), rgb(255, 156, 54))",
              );
            }
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
          await page.screenshot({
            path: testInfo.outputPath(`${name}.png`),
            fullPage:
              target.name === "kit-join" || (target.name === "kit-home" && state === "default"),
          });
          if (target.name === "kit" && viewport.size.width === 390 && state === "default") {
            await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
            const header = page.locator("[data-kit-site-header]");
            await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
            await expect(header).toBeVisible();
            const bounds = await header.boundingBox();
            expect(bounds).not.toBeNull();
            expect(Math.abs(bounds?.y ?? Infinity)).toBeLessThanOrEqual(1);
            const surface = await header.evaluate((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 5);
              const sample = document.createElement("span");
              sample.style.backgroundColor = "var(--g0, var(--color-page))";
              element.appendChild(sample);
              const expectedBackground =
                element.id === "menu-sheet"
                  ? getComputedStyle(sample).backgroundColor
                  : getComputedStyle(element.closest(".base-theme")!).backgroundColor;
              sample.remove();
              return {
                background: style.backgroundColor,
                expectedBackground,
                opacity: style.opacity,
                coversContent: topmost !== null && element.contains(topmost),
              };
            });
            expect(surface.background).toBe(surface.expectedBackground);
            expect(surface.background).not.toBe("rgba(0, 0, 0, 0)");
            expect(surface.opacity).toBe("1");
            expect(surface.coversContent).toBe(true);
            await page.screenshot({
              path: testInfo.outputPath(`${name}-scrolled.png`),
              fullPage: false,
            });
            const scrollPadding = await page.evaluate(() =>
              Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
            );
            expect(scrollPadding).toBeGreaterThanOrEqual(bounds?.height ?? Infinity);
            const contentLink = page.locator("main a:visible").first();
            await contentLink.focus();
            await expect(contentLink).toBeFocused();
            const targetBounds = await contentLink.boundingBox();
            const headerBounds = await header.boundingBox();
            expect(targetBounds).not.toBeNull();
            expect(targetBounds?.y ?? -Infinity).toBeGreaterThanOrEqual(
              (headerBounds?.y ?? Infinity) + (headerBounds?.height ?? Infinity),
            );
          }
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
