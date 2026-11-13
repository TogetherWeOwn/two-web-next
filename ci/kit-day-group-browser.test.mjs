import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler");

test("day groups retain their kit layout and list semantics at both widths", {
  timeout: 120000,
}, async () => {
  let css = "";
  const result = await build({
    stdin: {
      contents: `import { render } from 'svelte/server'; import Fixture from ${JSON.stringify(join(root, "test/fixtures/kit-day-group.svelte"))}; export const html = render(Fixture).body;`,
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
        name: "day-group-ssr",
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
  const { createServer: createViteServer } = await import(
    pathToFileURL(webRequire.resolve("vite"))
  );
  const { default: tailwindcss } = await import(
    pathToFileURL(webRequire.resolve("@tailwindcss/vite"))
  );
  const vite = await createViteServer({
    configFile: false,
    root: join(root, "web"),
    plugins: [tailwindcss()],
    server: { middlewareMode: true },
  });
  let styles;
  try {
    const transformed = await vite.transformRequest("/src/app.css?direct");
    assert.ok(transformed, "Kit stylesheet must compile");
    styles = transformed.code;
  } finally {
    await vite.close();
  }
  const server = createServer((request, response) => {
    if (request.url === "/styles.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(
        `${styles}\n${css}\n.day-group-token-probe { color: var(--t3); font-family: var(--font-data); }`,
      );
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
      const context = await browser.newContext({ javaScriptEnabled: false, viewport });
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const groups = page.locator("section.day-group");
        assert.equal(await groups.count(), 2);
        assert.equal(await groups.nth(0).locator("h2").textContent(), "Monday, 1 December");
        assert.equal(await groups.nth(1).locator("h3").textContent(), "Tuesday, 2 December");
        assert.equal(await groups.nth(0).locator("ul > li").count(), 2);
        assert.equal(await groups.nth(1).locator("ul > li").count(), 1);
        assert.deepEqual(await groups.locator("ul > li").allTextContents(), [
          "Community night",
          "Practice session",
          "Open lobby",
        ]);
        const heading = await groups
          .nth(0)
          .locator("h2")
          .evaluate((element) => {
            const style = getComputedStyle(element);
            const probe = document.createElement("span");
            probe.className = "day-group-token-probe";
            element.append(probe);
            const expected = getComputedStyle(probe);
            const result = {
              padding: style.paddingLeft,
              transform: style.textTransform,
              color: style.color,
              expectedColor: expected.color,
              font: style.fontFamily,
              expectedFont: expected.fontFamily,
              tertiary: style.getPropertyValue("--t3").trim(),
              dataFont: style.getPropertyValue("--font-data").trim(),
            };
            probe.remove();
            return result;
          });
        assert.equal(heading.padding, "16px");
        assert.equal(heading.transform, "uppercase");
        assert.ok(heading.tertiary);
        assert.ok(heading.dataFont);
        assert.equal(heading.color, heading.expectedColor);
        assert.equal(heading.font, heading.expectedFont);
        assert.equal(
          await groups.nth(1).evaluate((element) => getComputedStyle(element).marginTop),
          "28px",
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
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
