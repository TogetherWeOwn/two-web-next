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
        // Tailwind normally expands the generated @theme block into root variables.
        const theme = readFileSync("web/src/ember-theme.css", "utf8").replace("@theme{", ":root{");
        const html = renderer
          .renderPage({})
          .replace(
            "</head>",
            `<style>${theme}
              html, body { background: var(--color-lobby-surface); color: var(--color-lobby-ink); }
              body { font-family: var(--font-ui); }
              main { padding: var(--space-10) var(--space-6); }
              ${css}</style></head>`,
          )
          .replace("<body>", '<body class="base-theme">')
          .replace(
            "</body>",
            '<main id="main" tabindex="-1"><h1>Community events</h1><p>Find a gathering and join in.</p></main></body>',
          );
        await page.route("**/skip-link-fixture", (route) =>
          route.fulfill({ status: 200, contentType: "text/html", body: html }),
        );
        await page.goto("/skip-link-fixture");
        const link = page.getByRole("link", { name: "Skip to content" });
        await page.keyboard.press("Tab");
        await expect(link).toBeFocused();
        await expect(link).toBeInViewport();
        await expect(link).toHaveCSS("background-color", "rgb(255, 156, 54)");
        await expect(link).toHaveCSS("color", "rgb(29, 11, 0)");
        await expect(page.locator("body")).toHaveCSS("background-color", "rgb(28, 22, 20)");
        const linkBox = await link.boundingBox();
        const headingBox = await page
          .getByRole("heading", { name: "Community events" })
          .boundingBox();
        expect(linkBox).not.toBeNull();
        expect(headingBox).not.toBeNull();
        expect(linkBox!.y + linkBox!.height).toBeLessThan(headingBox!.y);
        if (javaScriptEnabled) {
          for (const [name, viewport] of [
            ["desktop", { width: 1280, height: 800 }],
            ["mobile", { width: 390, height: 844 }],
          ] as const) {
            await page.setViewportSize(viewport);
            const screenshot = `kit-review-skip-link-${name}`;
            const path = test.info().outputPath(`${screenshot}.png`);
            await page.screenshot({ path });
            await test.info().attach(screenshot, { path, contentType: "image/png" });
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
            const screenshot = `kit-review-skip-link-forced-colors-${name}`;
            const path = test.info().outputPath(`${screenshot}.png`);
            await page.screenshot({ path });
            await test.info().attach(screenshot, { path, contentType: "image/png" });
          }
        }
      } finally {
        renderer.cleanup();
      }
    });
  });
}
