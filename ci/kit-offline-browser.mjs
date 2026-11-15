import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { withKitBrowserFixture } from "./kit-browser-fixture.mjs";

const assetTypes = new Map([
  [".css", "text/css"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

// Resolve both the requested file and its root, so symlinks cannot escape.
export async function readFixtureAsset(directory, pathname, { allowJavaScript = false } = {}) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const extension = extname(decoded).toLowerCase();
  const type =
    allowJavaScript && extension === ".js" ? "text/javascript" : assetTypes.get(extension);
  if (!type || !decoded.startsWith("/") || decoded.includes("\\") || decoded.includes("\0"))
    return null;
  if (decoded.split("/").some((part) => part === "." || part === "..")) return null;
  try {
    const root = await realpath(directory);
    const candidate = await realpath(resolve(root, `.${decoded}`));
    const rel = relative(root, candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return { contentType: type, body: await readFile(candidate) };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error.code)) return null;
    throw error;
  }
}

// Build and render the supplied page without allowing browser network access.
export async function withKitOfflineBrowser(
  { source, page: fixture, search = "", javaScriptEnabled = false },
  callback,
) {
  if (typeof search !== "string" || (search && !search.startsWith("?")) || search.includes("#")) {
    throw new Error("Fixture search must be a query string");
  }
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
    const fixtureUrl = new URL(path + search, origin).href;
    const response = await server.respond(new Request(fixtureUrl), {
      getClientAddress: () => "127.0.0.1",
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ javaScriptEnabled });
      const unexpected = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && route.request().method() === "GET") {
          if (url.href === fixtureUrl)
            return route.fulfill({ contentType: "text/html", body: html });
          const isAppAsset = url.pathname.startsWith("/_app/");
          const directory = isAppAsset ? join(output, "client") : join(root, "public");
          const asset = await readFixtureAsset(directory, url.pathname, {
            allowJavaScript: isAppAsset && javaScriptEnabled,
          });
          if (asset) return route.fulfill(asset);
        }
        unexpected.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      try {
        await page.goto(fixtureUrl);
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
