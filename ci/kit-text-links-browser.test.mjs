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
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler");
const tailwind = webRequire("tailwindcss");

test("text links retain native keyboard navigation and a visible focus treatment", {
  timeout: 120000,
}, async () => {
  let css = "";
  const result = await build({
    stdin: {
      contents: `import { render } from 'svelte/server'; import Fixture from ${JSON.stringify(join(root, "test/fixtures/kit-text-links.svelte"))}; export const html = render(Fixture).body;`,
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
        name: "text-links-ssr",
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
  assert.ok(css.trim(), "component CSS must be emitted");
  const theme = readFileSync(join(root, "web/src/ember-theme.css"), "utf8");
  const styles = (await tailwind.compile(`${theme}\n${css}`)).build([]);
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
    const scenarios = [
      { width: 390, height: 844, javaScriptEnabled: false },
      { width: 390, height: 844, javaScriptEnabled: true },
      { width: 1280, height: 800, javaScriptEnabled: false },
      { width: 1280, height: 800, javaScriptEnabled: true },
    ];
    for (const { width, height, javaScriptEnabled } of scenarios) {
      const context = await browser.newContext({ javaScriptEnabled, viewport: { width, height } });
      try {
        const page = await context.newPage();
        const origin = `http://127.0.0.1:${server.address().port}`;
        await page.goto(origin);
        const links = page.locator("a");
        assert.equal(await links.count(), 3);
        for (let index = 0; index < 3; index++) {
          await page.keyboard.press("Tab");
          assert.equal(
            await links
              .nth(index)
              .evaluate(
                (element) =>
                  element === document.activeElement && element.matches(":focus-visible"),
              ),
            true,
          );
          const outline = await links.nth(index).evaluate((element) => ({
            style: getComputedStyle(element).outlineStyle,
            width: parseFloat(getComputedStyle(element).outlineWidth),
          }));
          assert.notEqual(outline.style, "none");
          assert.ok(outline.width > 0);
        }
        const buttonStyle = await links.nth(2).evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            padding: style.paddingTop,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            fontFamily: style.fontFamily,
          };
        });
        assert.equal(buttonStyle.padding, "8px");
        assert.equal(buttonStyle.fontSize, "14px");
        assert.equal(buttonStyle.fontWeight, "500");
        assert.match(buttonStyle.fontFamily, /Mona Sans/i);
        assert.ok((await links.nth(2).boundingBox()).height >= 36);
        await page.emulateMedia({ forcedColors: "active" });
        assert.notEqual(
          await links.nth(2).evaluate((element) => getComputedStyle(element).outlineStyle),
          "none",
        );
        await page.keyboard.press("Enter");
        await page.waitForURL(`${origin}/join`);
        assert.equal(new URL(page.url()).pathname, "/join");
      } finally {
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
