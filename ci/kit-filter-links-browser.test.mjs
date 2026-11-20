import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const loadWeb = (name) => import(pathToFileURL(webRequire.resolve(name)).href);

async function checkFilterLinks(entry, themeClass) {
  const output = await mkdtemp(join(tmpdir(), "kit-filter-browser-"));
  let server;
  let browser;
  try {
    const [{ build }, { default: tailwind }, { svelte }] = await Promise.all([
      loadWeb("vite"),
      loadWeb("@tailwindcss/vite"),
      loadWeb("@sveltejs/vite-plugin-svelte"),
    ]);
    await build({
      configFile: false,
      root: join(root, "web"),
      plugins: [tailwind(), svelte({ configFile: false })],
      resolve: { dedupe: ["svelte"] },
      build: {
        outDir: output,
        emptyOutDir: false,
        lib: {
          entry: join(root, "test/fixtures", entry),
          formats: ["es"],
          fileName: "fixture",
        },
      },
    });
    const names = await readdir(output);
    const cssName = names.find((name) => name.endsWith(".css"));
    const jsName = names.find((name) => name.endsWith(".js"));
    assert.ok(cssName && jsName, "Vite must emit fixture CSS and JavaScript");
    const assets = new Map([
      ["/fixture.css", ["text/css", await readFile(join(output, cssName))]],
      ["/fixture.js", ["text/javascript", await readFile(join(output, jsName))]],
    ]);
    server = createServer((request, response) => {
      const asset = assets.get(request.url);
      if (asset) {
        response.writeHead(200, { "content-type": asset[0] });
        response.end(asset[1]);
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body class="${themeClass}"><script type="module" src="/fixture.js"></script></body></html>`,
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator("a").nth(3).waitFor();
    const styles = await page.locator("a").evaluateAll((links) =>
      links.map((link) => {
        const style = getComputedStyle(link);
        const count = link.querySelector(".count");
        return {
          gap: style.gap,
          padding: style.paddingInlineStart,
          radius: style.borderRadius,
          fontSize: style.fontSize,
          weight: style.fontWeight,
          family: style.fontFamily,
          countFamily: count && getComputedStyle(count).fontFamily,
        };
      }),
    );
    for (const style of styles) {
      assert.equal(style.gap, "8px");
      assert.equal(style.radius, "999px");
      assert.equal(style.fontSize, "14px");
      assert.equal(style.weight, "500");
      assert.match(style.family, /Mona Sans/i);
    }
    assert.equal(styles[0].padding, "16px");
    assert.equal(styles[2].padding, "14px");
    assert.match(styles[0].countFamily, /Fragment Mono/i);
    assert.match(styles[2].countFamily, /Fragment Mono/i);
    await page.keyboard.press("Tab");
    const focus = await page
      .locator("a")
      .first()
      .evaluate((element) => ({
        width: getComputedStyle(element).outlineWidth,
        offset: getComputedStyle(element).outlineOffset,
        style: getComputedStyle(element).outlineStyle,
      }));
    assert.equal(focus.width, "2px");
    assert.equal(focus.offset, "3px");
    assert.equal(focus.style, "solid");

    await page.emulateMedia({ forcedColors: "active" });
    await page.keyboard.press("Tab");
    const segments = page.getByRole("navigation", { name: "Event views" }).locator("a");
    const outline = (element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, offset: style.outlineOffset, style: style.outlineStyle };
    };
    const selectedUnfocused = await segments.first().evaluate(outline);
    assert.deepEqual(selectedUnfocused, { width: "1px", offset: "-1px", style: "solid" });
    assert.equal(
      await segments.nth(1).evaluate((element) => element.matches(":focus-visible")),
      true,
    );
    assert.deepEqual(await segments.nth(1).evaluate(outline), focus);
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await segments.first().evaluate((element) => element.matches(":focus-visible")),
      true,
    );
    assert.deepEqual(await segments.first().evaluate(outline), focus);
  } finally {
    if (browser) await browser.close();
    if (server)
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(output, { recursive: true, force: true });
  }
}

for (const [stylesheet, entry, themeClass] of [
  ["Svelte source stylesheet", "kit-filter-browser-entry.js", "base-theme"],
  ["static stylesheet", "kit-filter-static-browser-entry.js", "base-theme schedule-theme"],
]) {
  test(
    `imported filter links retain their theme-backed styles with the ${stylesheet}`,
    { timeout: 120000 },
    () => checkFilterLinks(entry, themeClass),
  );
}
