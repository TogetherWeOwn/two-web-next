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

// Module-scope `Date` for the bundled server only; the process global is untouched.
export function fixedDateBanner(now) {
  if (!Number.isSafeInteger(now) || Number.isNaN(new Date(now).getTime())) {
    throw new Error("Fixture now must be epoch milliseconds");
  }
  return `const Date = new Proxy(globalThis.Date, {
  construct: (target, args, newTarget) =>
    Reflect.construct(target, args.length ? args : [${now}], newTarget === Date ? target : newTarget),
  apply: (target) => new target(${now}).toString(),
  get: (target, key) => (key === "now" ? () => ${now} : Reflect.get(target, key, target)),
});`;
}

// Render trusted repository fixtures with in-memory assets and routed HTTP/WebSocket denial.
// This is not a hostile-code sandbox: other transports, including WebRTC, are not
// universally denied or observed by `unexpected`. Use disposable CI without
// production credentials; an empty `unexpected` only covers routed requests.
/**
 * `now` (epoch ms) fixes the server clock; `timezoneId` overrides only the browser timezone.
 * `searches` opts in extra exact query strings of the same path; `open(search)` navigates to one.
 * `headerMenu` admits the exact menu island. Set `csr: true` to also hydrate that fixture.
 * `pageServer` installs a server load for the scratch fixture route only.
 * @param {{ source?: string, page: string, pageServer?: string, search?: string, searches?: string[], now?: number, javaScriptEnabled?: boolean, timezoneId?: string, headerMenu?: boolean, csr?: boolean }} options
 */
export async function withKitOfflineBrowser(
  {
    source,
    page: fixture,
    pageServer,
    search = "",
    searches = [],
    now = undefined,
    javaScriptEnabled = false,
    timezoneId,
    headerMenu = false,
    csr = javaScriptEnabled && !headerMenu,
  },
  callback,
) {
  for (const value of [search, ...searches]) {
    if (typeof value !== "string" || (value && !value.startsWith("?")) || value.includes("#")) {
      throw new Error("Fixture search must be a query string");
    }
  }
  const banner = now === undefined ? undefined : fixedDateBanner(now);
  const options = { source, page: fixture, pageServer, csr };
  return withKitBrowserFixture(options, async ({ root, output }) => {
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
      ...(banner && { banner: { js: banner } }),
      plugins: [
        {
          name: "offline-fixture",
          setup(plugin) {
            plugin.onLoad({ filter: /[/\\]entries[/\\]hooks\.server\.js$/ }, () => ({
              contents: "export const handle = ({event, resolve}) => resolve(event);",
            }));
            plugin.onLoad(
              { filter: /[/\\]entries[/\\]pages[/\\].*server\.ts\.js$/ },
              ({ path }) => {
                if (pageServer !== undefined && /[/\\]__browser_fixture__[/\\]/.test(path)) return;
                return { contents: "export const load = () => ({});" };
              },
            );
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
    const pages = new Map();
    for (const value of new Set([search, ...searches])) {
      const href = new URL(path + value, origin).href;
      const response = await server.respond(new Request(href), {
        getClientAddress: () => "127.0.0.1",
      });
      assert.equal(response.status, 200);
      pages.set(href, await response.text());
    }
    const html = pages.get(fixtureUrl);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        javaScriptEnabled,
        serviceWorkers: "block",
        timezoneId,
      });
      const unexpected = [];
      await context.routeWebSocket("**/*", (socket) => {
        unexpected.push(socket.url());
        socket.close();
      });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin && route.request().method() === "GET") {
          if (pages.has(url.href))
            return route.fulfill({
              contentType: "text/html",
              headers: { "content-security-policy": "worker-src 'none'; frame-src 'none'" },
              body: pages.get(url.href),
            });
          const isAppAsset = url.pathname.startsWith("/_app/");
          const isMenu = url.pathname === "/islands/site-header-menu.js";
          const directory = isAppAsset ? join(output, "client") : join(root, "public");
          const asset = await readFixtureAsset(directory, url.pathname, {
            allowJavaScript: javaScriptEnabled && ((headerMenu && isMenu) || (csr && isAppAsset)),
          });
          if (asset) return route.fulfill(asset);
        }
        unexpected.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      try {
        await page.goto(fixtureUrl);
        const open = async (value) => {
          const href = new URL(path + value, origin).href;
          assert.ok(pages.has(href), `Fixture search not allowlisted: ${value}`);
          await page.goto(href);
          return pages.get(href);
        };
        return await callback({ page, html, open, unexpected: [...unexpected] });
      } finally {
        await context.close();
        assert.deepEqual(unexpected, []);
      }
    } finally {
      await browser.close();
    }
  });
}
