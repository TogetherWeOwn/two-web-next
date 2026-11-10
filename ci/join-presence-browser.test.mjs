// Run after the Kit adapter build. Real Hono page shell and built Kit runtime;
// data loads/hooks are fixtures. Every browser request is intercepted locally.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { chromium } from "playwright";
import { toPublicWidgetSnapshot } from "../src/discord-widget.ts";
import { HOME_JOIN_RESULT_COPY, JOIN_INTRO } from "../src/home-copy.ts";
import { Join } from "../src/screens/join.tsx";

const output = resolve("web/.svelte-kit/output");
const evidence = process.env.JOIN_PRESENCE_EVIDENCE_DIR;
const origin = "http://join-presence.test";
const inviteUrl = "https://discord.gg/invite";
const widgetUrl = "https://discord.com/widget?id=326474832151838730&theme=dark";
const snapshot = {
  guildId: "326474832151838730",
  name: "Together We Own",
  inviteUrl,
  presenceCount: 42,
  channels: [],
  members: [],
  fetchedAt: 0,
};
const fixtures = [
  { name: "fresh", snapshot, widgetUrl },
  { name: "stale", snapshot: { ...snapshot, stale: true }, widgetUrl },
  { name: "dropped", snapshot: null, widgetUrl },
  { name: "unavailable", snapshot: null, widgetUrl: null },
];
let scratch;
let browser;

before(async () => {
  scratch = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "join-presence-"),
  );
  const entry = join(scratch, "server.mjs");
  await build({
    stdin: {
      contents: `import { Server } from ${JSON.stringify(join(output, "server/index.js"))};
        import { manifest } from ${JSON.stringify(join(output, "server/manifest.js"))};
        export function fixtureServer(data) {
          const nodes = manifest.nodes.map(load => async () => {
            const node = await load();
            return node.server ? {...node, server: {csr: false, load: () => node.server_id.includes('+layout') ? {} : data()}} : node;
          });
          return new Server({...manifest, nodes});
        }`,
      resolveDir: process.cwd(),
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    nodePaths: [resolve("web/node_modules"), resolve("node_modules")],
    plugins: [
      {
        name: "offline-join-data",
        setup(plugin) {
          plugin.onLoad({ filter: /[/\\]entries[/\\]hooks\.server\.js$/ }, () => ({
            contents: "export const handle = ({event, resolve}) => resolve(event);",
          }));
          plugin.onLoad({ filter: /[/\\]entries[/\\]pages[/\\].*server\.ts\.js$/ }, () => ({
            contents: "export const csr = false; export const load = () => ({});",
          }));
          plugin.onLoad({ filter: /[/\\]entries[/\\]endpoints[/\\]/ }, () => ({
            contents: "export const GET = () => { throw new Error('Endpoint outside fixture'); };",
          }));
        },
      },
    ],
    logLevel: "silent",
  });
  let data;
  const { fixtureServer } = await import(pathToFileURL(entry).href);
  const server = fixtureServer(() => data);
  await server.init({ env: {}, read: (file) => readFile(join(output, "client", file)) });
  for (const f of fixtures) {
    data = {
      appUrl: origin,
      inviteUrl,
      widgetUrl: f.widgetUrl,
      widgetSnapshot: toPublicWidgetSnapshot(f.snapshot),
      widgetStale: f.snapshot?.stale ?? false,
      oneClickHref: "/join/discord",
      joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
      joinResult: null,
      notice: null,
    };
    const response = await server.respond(new Request(origin + "/join"), {
      getClientAddress: () => "127.0.0.1",
    });
    assert.equal(response.status, 200);
    f.kit = await response.text();
    assert.match(f.kit, /_app\/immutable\/assets\/0\.[^"]+\.css/, "built root stylesheet");
    f.hono = jsx(Join, {
      appUrl: origin,
      inviteUrl,
      widgetUrl: f.widgetUrl,
      widgetSnapshot: f.snapshot,
    }).toString();
  }
  browser = await chromium.launch({ headless: true });
  if (evidence) await mkdir(evidence, { recursive: true });
});

after(async () => {
  await browser?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("Join presence browser", () => {
  for (const renderer of ["hono", "kit"]) {
    for (const width of [1280, 390]) {
      for (const f of fixtures) {
        test(`${renderer} ${f.name} at ${width}`, async () => {
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 800 },
          });
          const unexpected = [];
          const errors = [];
          try {
            await context.route("**/*", async (route) => {
              const url = new URL(route.request().url());
              if (url.origin === origin && route.request().method() === "GET") {
                if (url.pathname === "/join")
                  return route.fulfill({ contentType: "text/html", body: f[renderer] });
                const directory = url.pathname.startsWith("/_app/")
                  ? join(output, "client")
                  : resolve("public");
                const asset = resolve(directory, url.pathname.slice(1));
                const type = {
                  css: "text/css",
                  js: "text/javascript",
                  woff2: "font/woff2",
                  png: "image/png",
                  svg: "image/svg+xml",
                  ico: "image/x-icon",
                }[asset.split(".").pop()];
                if (asset.startsWith(directory + "/") && type) {
                  return route.fulfill({ contentType: type, body: await readFile(asset) });
                }
              }
              unexpected.push(url.pathname);
              return route.abort();
            });
            const page = await context.newPage();
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(origin + "/join");
            await page.locator("#join-heading").waitFor();
            await page.evaluate(() => document.fonts.ready);
            assert.equal(
              await page.locator('[data-testid="join-oneclick"]').getAttribute("href"),
              "/join/discord",
            );
            assert.equal(
              await page.locator('[data-testid="join-invite"]').getAttribute("href"),
              inviteUrl,
            );
            const presence = page.locator('[data-testid="join-widget-presence"]');
            if (!f.snapshot) {
              assert.equal(await presence.count(), 0);
              const fallback = f.widgetUrl ? "join-widget-load" : "join-widget-fallback";
              assert.equal(await page.locator(`[data-testid="${fallback}"]`).count(), 1);
            } else {
              const text = await presence.innerText();
              assert.match(text, /42 members online/);
              assert.match(
                text,
                f.name === "stale" ? /as of the last update/ : /In Together We Own now/,
              );
              assert.match(
                text,
                f.name === "stale"
                  ? /No voice channels open as of the last update/
                  : /No voice channels open right now/,
              );
              if (f.name === "stale") assert.doesNotMatch(text, /\bnow\b/);
            }
            assert.equal(await page.locator("iframe").count(), 0, "preview stays opt-in");
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              "no horizontal overflow",
            );
            if (evidence)
              await page.screenshot({
                path: join(evidence, `${renderer}-${f.name}-${width}.png`),
                fullPage: true,
              });
            assert.deepEqual(unexpected, [], "no network outside local fixtures");
            assert.deepEqual(errors, [], "no browser exceptions");
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});
