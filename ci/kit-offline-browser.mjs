import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { withKitBrowserFixture } from "./kit-browser-fixture.mjs";

// Build and render the supplied page without allowing browser network access.
export async function withKitOfflineBrowser({ source, page: fixture }, callback) {
  return withKitBrowserFixture({ source, page: fixture }, async ({ root, output }) => {
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
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ javaScriptEnabled: false });
      const unexpected = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && route.request().method() === "GET") {
          if (url.pathname === path) return route.fulfill({ contentType: "text/html", body: html });
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
      try {
        await page.goto(origin + path);
        return await callback({ page, html, unexpected: [...unexpected] });
      } finally {
        await context.close();
        assert.deepEqual(unexpected, []);
      }
    } finally {
      await browser.close();
    }
  });
}
