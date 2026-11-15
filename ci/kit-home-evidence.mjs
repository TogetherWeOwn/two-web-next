// Non-shipping screenshot evidence for the Kit home page. Builds the real
// web/src/routes/+page.svelte inside a disposable copy (see
// kit-browser-fixture.mjs) with fixed data, renders guest/member x
// populated/degraded at desktop and mobile widths, and writes PNGs plus a
// manifest. Nothing here changes a route, hook, or auth path; the evidence
// route exists only in the scratch copy. Usage: node ci/kit-home-evidence.mjs [outDir]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { withKitBrowserFixture } from "./kit-browser-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const VIEWPORTS = [
  ["desktop", 1280, 800],
  ["mobile", 390, 844],
];
// Each state names markup the real page must render, so a silently wrong
// branch fails the run instead of producing a plausible screenshot.
export const STATES = [
  [
    "guest-populated",
    "guest",
    "populated",
    ["home-events-list", "join", "home-events-join", "featured-content"],
    ["home-events-empty"],
  ],
  [
    "member-populated",
    "member",
    "populated",
    ["home-events-list", "featured-content"],
    ["signin", "home-events-join"],
  ],
  [
    "guest-empty",
    "guest",
    "empty",
    ["home-events-empty", "home-events-join"],
    ["home-events-list"],
  ],
  ["member-empty", "member", "empty", ["home-events-empty"], ["home-events-list", "signin"]],
  [
    "guest-degraded",
    "guest",
    "degraded",
    ["home-events-empty", "discord-join"],
    ["home-events-list", "featured-content", "member-count"],
  ],
  [
    "member-degraded",
    "member",
    "degraded",
    ["home-events-empty"],
    ["signin", "home-events-list", "member-count"],
  ],
];
const origin = "http://kit-fixture.test";
const path = "/__browser_fixture__";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export async function captureHomeEvidence(outDir, source = process.cwd()) {
  outDir = resolve(outDir);
  await mkdir(outDir, { recursive: true });
  const page = await readFile(join(here, "kit-home-evidence.svelte.txt"), "utf8");
  return withKitBrowserFixture({ source, page }, async ({ root, output }) => {
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
          // Same stubs as kit-offline-browser.mjs: no Workers bindings, DB or auth.
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
    const documents = new Map();
    for (const [name, viewer, data, present, absent] of STATES) {
      const response = await server.respond(
        new Request(`${origin}${path}?viewer=${viewer}&data=${data}`),
        { getClientAddress: () => "127.0.0.1" },
      );
      assert.equal(response.status, 200, `${name} responded ${response.status}`);
      const html = await response.text();
      for (const id of present)
        assert.ok(html.includes(`data-testid="${id}"`), `${name}: expected ${id}`);
      for (const id of absent)
        assert.ok(!html.includes(`data-testid="${id}"`), `${name}: unexpected ${id}`);
      documents.set(name, html);
    }
    // Only same-origin GETs of built Kit assets and the repo's public/ files
    // are served; everything else is aborted and fails the run.
    const roots = [join(output, "client"), join(root, "public")];
    const serveStatic = async (pathname) => {
      for (const directory of roots) {
        const file = resolve(directory, decodeURIComponent(pathname).slice(1));
        if (!file.startsWith(directory + sep)) continue;
        try {
          return { file, body: await readFile(file) };
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
        }
      }
      return null;
    };
    const types = { css: "text/css", woff2: "font/woff2", svg: "image/svg+xml", png: "image/png" };
    const browser = await chromium.launch({ headless: true });
    const shots = [];
    try {
      for (const [name] of STATES) {
        for (const [label, width, height] of VIEWPORTS) {
          const context = await browser.newContext({
            viewport: { width, height },
            deviceScaleFactor: 1,
            javaScriptEnabled: false,
          });
          const unexpected = [];
          await context.route("**/*", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin === origin && request.method() === "GET") {
              if (url.pathname === path)
                return route.fulfill({ contentType: "text/html", body: documents.get(name) });
              const asset = await serveStatic(url.pathname);
              if (asset) {
                const type = types[asset.file.split(".").pop()];
                if (type) return route.fulfill({ contentType: type, body: asset.body });
              }
            }
            unexpected.push(request.url());
            return route.abort();
          });
          const tab = await context.newPage();
          try {
            await tab.goto(`${origin}${path}`, { waitUntil: "load" });
            await tab.evaluate(() => document.fonts.ready);
            const file = `home-${name}-${label}.png`;
            const png = await tab.screenshot({ path: join(outDir, file), fullPage: true });
            shots.push({
              state: name,
              viewport: { label, width, height },
              file,
              sha256: sha256(png),
            });
          } finally {
            await context.close();
          }
          assert.deepEqual(unexpected, [], `${name}/${label}: unexpected requests`);
        }
      }
    } finally {
      await browser.close();
    }
    const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
    const manifestOut = {
      head: git("rev-parse", "HEAD"),
      runUrl: process.env.GITHUB_RUN_ID
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
      page: "web/src/routes/+page.svelte",
      fixture:
        "Disposable copy; test data; hooks, loads and endpoints stubbed; JavaScript disabled",
      note: "Event times are relative to the run time; screenshots are review evidence, not baselines",
      screenshots: shots,
    };
    await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifestOut, null, 2)}\n`);
    return manifestOut;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await captureHomeEvidence(process.argv[2] ?? "artifacts/kit-home-evidence");
  console.log(`captured ${result.screenshots.length} screenshots`);
}
