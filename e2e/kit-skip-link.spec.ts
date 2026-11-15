import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createKitSsrRenderer } from "../test/helpers/kit-ssr-render";

const component = "web/src/lib/SkipLink.svelte";
const webRequire = createRequire(resolve("web/package.json"));
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { css: { code: string } };
};

for (const javaScriptEnabled of [true, false]) {
  test.describe(`skip link with JavaScript ${javaScriptEnabled ? "on" : "off"}`, () => {
    test.use({ javaScriptEnabled });

    test("reveals on keyboard focus and moves focus to main", async ({ page }) => {
      const renderer = await createKitSsrRenderer(component);
      try {
        const css = compile(readFileSync(component, "utf8"), {
          generate: "server",
          filename: resolve(component),
        }).css.code;
        const html = renderer
          .renderPage({})
          .replace(
            "</head>",
            `<style>:root { --space-3: 12px; --focus-width: 2px; --focus-offset: 3px; --focus-ring: black; } ${css}</style></head>`,
          )
          .replace("</body>", '<main id="main" tabindex="-1">Main content</main></body>');
        await page.route("**/skip-link-fixture", (route) =>
          route.fulfill({ status: 200, contentType: "text/html", body: html }),
        );
        await page.goto("/skip-link-fixture");
        const link = page.getByRole("link", { name: "Skip to content" });
        await page.keyboard.press("Tab");
        await expect(link).toBeFocused();
        await expect(link).toBeInViewport();
        if (javaScriptEnabled) {
          for (const [name, viewport] of [
            ["desktop", { width: 1280, height: 800 }],
            ["mobile", { width: 390, height: 844 }],
          ] as const) {
            await page.setViewportSize(viewport);
            await test.info().attach(`kit-review-skip-link-${name}`, {
              body: await page.screenshot(),
              contentType: "image/png",
            });
          }
        }
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(/#main$/);
        await expect(page.locator("main")).toBeFocused();

        await page.emulateMedia({ forcedColors: "active" });
        await page.keyboard.press("Shift+Tab");
        await expect(link).toBeFocused();
        const border = await link.evaluate((element) => getComputedStyle(element).borderTopWidth);
        expect(border).toBe("1px");
        if (javaScriptEnabled) {
          for (const [name, viewport] of [
            ["desktop", { width: 1280, height: 800 }],
            ["mobile", { width: 390, height: 844 }],
          ] as const) {
            await page.setViewportSize(viewport);
            await test.info().attach(`kit-review-skip-link-forced-colors-${name}`, {
              body: await page.screenshot(),
              contentType: "image/png",
            });
          }
        }
      } finally {
        renderer.cleanup();
      }
    });
  });
}
