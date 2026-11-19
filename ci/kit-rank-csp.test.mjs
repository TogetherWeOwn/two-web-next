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

test("rank arcs use external CSS under a restrictive style CSP", { timeout: 120000 }, async () => {
  let css = "";
  const result = await build({
    stdin: {
      contents: `import { render } from 'svelte/server'; import Rank from ${JSON.stringify(join(root, "web/src/lib/RankLabel.svelte"))}; export const html = [1,2,3,4,5].map(rank => render(Rank, {props:{rank}}).body).join('');`,
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
        name: "rank-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const source = readFileSync(path, "utf8");
            const compiled = compile(source, { generate: "server", filename: path });
            css =
              compile(source, { generate: "client", css: "external", filename: path }).css?.code ??
              "";
            return { contents: compiled.js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
  const { html } = await import(moduleUrl);
  assert.ok(css, "component CSS must be emitted");
  const tokens = readFileSync(join(root, "vendor/design-kit/tokens.css"), "utf8");
  const server = createServer((request, response) => {
    if (request.url === "/styles.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(`${tokens}\n${css}`);
    } else if (request.url === "/observer.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(
        "window.violations=[]; document.addEventListener('securitypolicyviolation', e => window.violations.push(e.effectiveDirective));",
      );
    } else {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": "default-src 'none'; style-src 'self'; script-src 'self'",
      });
      response.end(
        `<!doctype html><html><head><script src="/observer.js"></script><link rel="stylesheet" href="/styles.css"></head><body>${html}<div id="blocked" style="color: rgb(1, 2, 3)">control</div></body></html>`,
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.violations.includes("style-src-attr"));
    const ranks = page.locator(".rank-label");
    assert.equal(await ranks.count(), 5);
    for (let rank = 1; rank <= 5; rank++) {
      const label = ranks.nth(rank - 1);
      assert.equal(await label.locator("svg[aria-hidden=true]").count(), 1);
      const arcs = label.locator("path");
      assert.equal(await arcs.count(), 5);
      for (let index = 0; index < 5; index++) {
        const arc = arcs.nth(index);
        assert.equal(await arc.getAttribute("style"), null);
        const token =
          index < rank ? `--two-color-rank-arc-${index + 1}` : "--two-color-rank-arc-off";
        const colors = await arc.evaluate((element, name) => {
          const value = getComputedStyle(element).getPropertyValue(name).trim();
          const reference = document.createElementNS("http://www.w3.org/2000/svg", "path");
          reference.setAttribute("stroke", `var(${name})`);
          element.parentElement.append(reference);
          const expected = getComputedStyle(reference).stroke;
          reference.remove();
          return { value, expected, actual: getComputedStyle(element).stroke };
        }, token);
        assert.ok(colors.value, `${token} must be defined`);
        assert.equal(colors.actual, colors.expected);
      }
    }
    assert.notEqual(
      await page.locator("#blocked").evaluate((el) => getComputedStyle(el).color),
      "rgb(1, 2, 3)",
    );
    await page.emulateMedia({ forcedColors: "active" });
    const lit = await ranks
      .last()
      .locator("path")
      .first()
      .evaluate((el) => getComputedStyle(el).stroke);
    const off = await ranks
      .first()
      .locator("path")
      .last()
      .evaluate((el) => getComputedStyle(el).stroke);
    assert.notEqual(lit, off);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(await page.evaluate(() => window.violations), ["style-src-attr"]);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
