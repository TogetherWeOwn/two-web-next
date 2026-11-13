import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const { compile } = createRequire(new URL("../web/package.json", import.meta.url))(
  "svelte/compiler",
);

test("footer remains usable at desktop and mobile widths", { timeout: 120000 }, async () => {
  let css = "";
  const result = await build({
    stdin: {
      contents: `import { render } from 'svelte/server'; import Fixture from ${JSON.stringify(join(root, "test/fixtures/kit-footer.svelte"))}; export const html = render(Fixture).body;`,
      resolveDir: root,
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    plugins: [
      {
        name: "footer-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const compiled = compile(readFileSync(path, "utf8"), {
              generate: "server",
              filename: path,
            });
            css += `${compiled.css?.code ?? ""}\n`;
            return { contents: compiled.js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  const { html } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
  assert.ok(css.trim());
  // Resolve the component's own CSS import, rather than injecting raw tokens separately.
  const bundledCss = await build({
    stdin: { contents: css, resolveDir: join(root, "web/src/lib"), loader: "css" },
    bundle: true,
    write: false,
  });
  const styles = `${bundledCss.outputFiles[0].text}\n${readFileSync(join(root, "web/src/ember-theme.css"), "utf8")}`;
  const server = createServer((request, response) => {
    if (request.url === "/styles.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(styles);
    } else {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'none'; style-src 'self'",
      });
      response.end(
        `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body class="base-theme">${html}</body></html>`,
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
    ]) {
      for (const javaScriptEnabled of [false, true]) {
        const context = await browser.newContext({ javaScriptEnabled, viewport });
        try {
          const page = await context.newPage();
          const origin = `http://127.0.0.1:${server.address().port}`;
          await page.goto(origin);
          const footer = page.getByRole("contentinfo");
          const nav = footer.getByRole("navigation", { name: "Footer" });
          const links = [
            ["About", "/about"],
            ["FAQ", "/faq"],
            ["House rules", "/rules"],
            ["Privacy", "/privacy"],
          ];
          assert.equal(await nav.getByRole("link").count(), links.length);
          assert.deepEqual(
            await footer.evaluate((element) => {
              const style = getComputedStyle(element);
              const probe = document.createElement("span");
              probe.style.color = "var(--two-color-text-tertiary)";
              element.append(probe);
              const matchesToken = style.color === getComputedStyle(probe).color;
              probe.remove();
              const token = getComputedStyle(element)
                .getPropertyValue("--two-color-text-tertiary")
                .trim();
              return [
                style.paddingTop,
                style.paddingLeft,
                style.fontSize,
                style.color,
                token,
                matchesToken,
              ];
            }),
            ["32px", "44px", "14px", "rgb(168, 154, 142)", "#a89a8e", true],
          );
          assert.equal(
            await footer
              .locator(".footer-content")
              .evaluate((element) => getComputedStyle(element).flexDirection),
            viewport.width === 390 ? "column" : "row",
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          for (const [name, href] of links) {
            const link = nav.getByRole("link", { name, exact: true });
            assert.equal(await link.getAttribute("href"), href);
            await page.keyboard.press("Tab");
            assert.equal(
              await link.evaluate(
                (element) =>
                  element === document.activeElement && element.matches(":focus-visible"),
              ),
              true,
            );
            assert.notEqual(
              await link.evaluate((element) => getComputedStyle(element).outlineStyle),
              "none",
            );
          }
          await page.emulateMedia({ forcedColors: "active" });
          const focused = nav.getByRole("link", { name: "Privacy", exact: true });
          assert.notEqual(
            await focused.evaluate((element) => getComputedStyle(element).outlineStyle),
            "none",
          );
          await page.keyboard.press("Enter");
          await page.waitForURL(`${origin}/privacy`);
          for (const [name, href] of links.slice(0, -1)) {
            await page.goto(origin);
            await page
              .getByRole("navigation", { name: "Footer" })
              .getByRole("link", { name, exact: true })
              .click();
            await page.waitForURL(`${origin}${href}`);
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
