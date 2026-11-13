import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { withKitBrowserFixture } from "./kit-browser-fixture.mjs";

test("Kit browser fixture renders SSR and loads its CSS offline", async () => {
  await withKitBrowserFixture(
    {
      page: `<script>import JsonLd from '#lib/JsonLd.svelte';</script>
<JsonLd testid="site-jsonld" json={'{"fixture":true}'} />
<p class="proof">Fixture rendered</p>
<style>.proof { color: rgb(12, 34, 56); }</style>`,
    },
    async ({ root, output }) => {
      const entry = join(root, "fixture-server.mjs");
      await build({
        stdin: {
          contents: `export { Server } from ${JSON.stringify(join(output, "server/index.js"))};
          export { manifest } from ${JSON.stringify(join(output, "server/manifest.js"))};`,
          resolveDir: root,
        },
        outfile: entry,
        bundle: true,
        platform: "node",
        format: "esm",
        plugins: [
          {
            name: "offline-fixture",
            setup(plugin) {
              plugin.onLoad({ filter: /[/\\]entries[/\\]hooks\.server\.js$/ }, () => ({
                contents: "export const handle = ({event, resolve}) => resolve(event);",
              }));
              plugin.onLoad({ filter: /[/\\]entries[/\\]pages[/\\].*server\.ts\.js$/ }, () => ({
                contents: "export const load = () => ({});",
              }));
              plugin.onLoad({ filter: /[/\\]entries[/\\]endpoints[/\\]/ }, () => ({
                contents:
                  "export const GET = () => { throw new Error('Endpoint outside fixture'); };",
              }));
            },
          },
        ],
        logLevel: "silent",
      });
      const { Server, manifest } = await import(pathToFileURL(entry).href);
      const server = new Server(manifest);
      await server.init({ env: {}, read: (file) => readFile(join(output, "client", file)) });
      const origin = "http://kit-fixture.test";
      const path = "/__browser_fixture__";
      const response = await server.respond(new Request(origin + path), {
        getClientAddress: () => "127.0.0.1",
      });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Fixture rendered/);
      assert.match(html, /data-testid="site-jsonld"/);
      assert.match(html, /_app\/immutable\/assets\/[^" ]+\.css/);
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ javaScriptEnabled: false });
        const unexpected = [];
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin === origin && route.request().method() === "GET") {
            if (url.pathname === path)
              return route.fulfill({ contentType: "text/html", body: html });
            const directory = join(output, "client");
            const asset = resolve(directory, url.pathname.slice(1));
            if (
              asset.startsWith(`${directory}/`) &&
              url.pathname.startsWith("/_app/") &&
              asset.endsWith(".css")
            ) {
              return route.fulfill({ contentType: "text/css", body: await readFile(asset) });
            }
          }
          unexpected.push(route.request().url());
          return route.abort();
        });
        const page = await context.newPage();
        await page.goto(origin + path);
        assert.equal(await page.locator(".proof").textContent(), "Fixture rendered");
        assert.equal(
          await page.locator(".proof").evaluate((el) => getComputedStyle(el).color),
          "rgb(12, 34, 56)",
        );
        assert.deepEqual(unexpected, []);
        await context.close();
      } finally {
        await browser.close();
      }
    },
  );
});
