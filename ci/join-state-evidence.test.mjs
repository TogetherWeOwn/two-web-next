// Join presence-state visual evidence harness (controller side).
//
// Adapted from the original harness at source SHA
// afbed516b6fdcd322d847317e4b95c42de7e95f1 (ci/join-presence-browser.test.mjs,
// read-only; never edited). This file lives in a separate controller checkout
// and renders a separately checked-out target application at an explicit root.
//
// Interface (all required):
//   JOIN_APP_SHA        exact expected application commit SHA.
//   APP_ROOT            absolute path of the target source checkout, with its
//                       dependencies installed and the Kit adapter already
//                       built (web/.svelte-kit/output). Must equal the cwd.
//   JOIN_EVIDENCE_DIR   absolute output directory for the screenshots.
// APP_ROOT HEAD must equal the pinned base application SHA below.
//
// Run from APP_ROOT:
//   node --import tsx --test <controller>/ci/join-state-evidence.test.mjs
//
// Output: 20 images named `<renderer>-<state>-<width>.png`, renderer in
// {hono,kit}, width in {1280,390}, state in {fresh-populated, age61s-populated,
// age61s-empty, age180s-populated, fresh-empty}. Fixture snapshots come from the target's
// own createDiscordWidgetHealth with an injected clock. Real Hono Join screen
// and the built Kit runtime render them; Kit data loads and hooks are
// substituted fixtures (no real auth/load stack is exercised). Every browser
// request is intercepted locally; nothing leaves the process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  deriveSnapshot,
  inviteUrl,
  memberNames as MEMBER_NAMES,
  scenarios as SCENARIOS,
} from "./join-state-fixtures.mjs";

const APP_SHA = process.env.JOIN_APP_SHA;
const WIDTHS = [1280, 390];
const RENDERERS = ["hono", "kit"];
const STATES = [
  "fresh-populated",
  "age61s-populated",
  "age61s-empty",
  "age180s-populated",
  "fresh-empty",
];

const origin = "http://join-state.test";

let appRoot;
let evidence;
let output;
let scratch;
let browser;
let fixtures = [];
const written = new Set();

function git(...args) {
  return execFileSync("git", args, { cwd: appRoot, encoding: "utf8" }).trim();
}

// Resolve a dependency from the target checkout (never the controller tree).
function appImport(specifier, explicitFile) {
  if (explicitFile && existsSync(join(appRoot, explicitFile)))
    return import(pathToFileURL(join(appRoot, explicitFile)).href);
  for (const base of [appRoot, join(appRoot, "web")]) {
    try {
      const file = createRequire(join(base, "noop.js")).resolve(specifier);
      return import(pathToFileURL(file).href);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`cannot resolve ${specifier} from ${appRoot}`);
}

const srcImport = (file) => import(pathToFileURL(join(appRoot, file)).href);

before(async () => {
  assert.ok(process.env.APP_ROOT, "APP_ROOT is required");
  assert.ok(isAbsolute(process.env.APP_ROOT), "APP_ROOT must be absolute");
  appRoot = resolve(process.env.APP_ROOT);
  assert.equal(resolve(process.cwd()), appRoot, "cwd must equal APP_ROOT");
  assert.ok(process.env.JOIN_EVIDENCE_DIR, "JOIN_EVIDENCE_DIR is required");
  assert.ok(isAbsolute(process.env.JOIN_EVIDENCE_DIR), "JOIN_EVIDENCE_DIR must be absolute");
  evidence = resolve(process.env.JOIN_EVIDENCE_DIR);
  assert.match(APP_SHA, /^[0-9a-f]{40}$/, "expected application SHA");
  assert.equal(git("rev-parse", "HEAD"), APP_SHA, "APP_ROOT HEAD is the target application SHA");
  assert.equal(
    git("status", "--porcelain", "--untracked-files=no"),
    "",
    "application tracked files unchanged",
  );
  output = join(appRoot, "web/.svelte-kit/output");
  assert.ok(existsSync(join(output, "server/index.js")), "built Kit output present");

  const { build } = await appImport("esbuild");
  const honoRuntime = await appImport(
    "hono/jsx/jsx-runtime",
    "node_modules/hono/dist/jsx/jsx-runtime.js",
  );
  const jsx = honoRuntime.jsx ?? honoRuntime.default?.jsx;
  const pw = await appImport("playwright");
  const chromium = pw.chromium ?? pw.default?.chromium;
  const { createDiscordWidgetHealth, toPublicWidgetSnapshot } =
    await srcImport("src/discord-widget.ts");
  const { HOME_JOIN_RESULT_COPY, JOIN_INTRO } = await srcImport("src/home-copy.ts");
  const { Join } = await srcImport("src/screens/join.tsx");

  scratch = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "join-state-"));
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
      resolveDir: appRoot,
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    nodePaths: [join(appRoot, "web/node_modules"), join(appRoot, "node_modules")],
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

  const realFetch = globalThis.fetch;
  for (const state of STATES) {
    const { snapshot, widgetUrl: url } = await deriveSnapshot(createDiscordWidgetHealth, state);
    data = {
      appUrl: origin,
      inviteUrl,
      widgetUrl: url,
      // Same projection and freshness flag the target Kit load returns.
      widgetSnapshot: toPublicWidgetSnapshot(snapshot),
      widgetStale: snapshot?.stale ?? false,
      oneClickHref: "/join/discord",
      joinCopy: { HOME_JOIN_RESULT_COPY, JOIN_INTRO },
      joinResult: null,
      notice: null,
    };
    // Server rendering must never reach the network.
    globalThis.fetch = async (input) => {
      throw new Error(`unexpected server fetch: ${String(input)}`);
    };
    let response;
    try {
      response = await server.respond(new Request(origin + "/join"), {
        getClientAddress: () => "127.0.0.1",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(response.status, 200);
    const kit = await response.text();
    assert.match(kit, /_app\/immutable\/assets\/0\.[^"]+\.css/, "built root stylesheet");
    const hono = jsx(Join, {
      appUrl: origin,
      inviteUrl,
      widgetUrl: url,
      widgetSnapshot: snapshot,
    }).toString();
    for (const html of [kit, hono])
      for (const name of MEMBER_NAMES)
        assert.ok(!html.includes(name), "member names stay off the public page");
    fixtures.push({ name: state, snapshot, widgetUrl: url, kit, hono });
  }

  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  // A skipped or partial run must fail, never pass silently.
  for (const renderer of RENDERERS)
    for (const width of WIDTHS)
      for (const state of STATES) {
        const name = `${renderer}-${state}-${width}.png`;
        assert.ok(written.has(name), `missing screenshot ${name}`);
        assert.ok((await stat(join(evidence, name))).size > 0, `empty screenshot ${name}`);
      }
  assert.equal(written.size, 20);
  if (appRoot)
    assert.equal(
      git("status", "--porcelain", "--untracked-files=no"),
      "",
      "application tracked files still unchanged",
    );
});

describe("Join presence state evidence", () => {
  for (const renderer of RENDERERS) {
    for (const width of WIDTHS) {
      for (const state of STATES) {
        test(`${renderer} ${state} at ${width}`, async () => {
          const f = fixtures.find((x) => x.name === state);
          assert.ok(f, `fixture ${state}`);
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 800 },
            serviceWorkers: "block",
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
                  : join(appRoot, "public");
                const asset = resolve(directory, url.pathname.slice(1));
                const type = {
                  css: "text/css",
                  js: "text/javascript",
                  woff2: "font/woff2",
                  png: "image/png",
                  svg: "image/svg+xml",
                  ico: "image/x-icon",
                }[asset.split(".").pop()];
                if (asset.startsWith(directory + "/") && type && existsSync(asset)) {
                  return route.fulfill({ contentType: type, body: await readFile(asset) });
                }
              }
              unexpected.push(url.href);
              return route.abort();
            });
            const page = await context.newPage();
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(origin + "/join");
            await page.locator("#join-heading").waitFor();
            const fonts = await page.evaluate(async () => {
              await document.fonts.ready;
              return Array.from(document.fonts, ({ family, status }) => ({ family, status }));
            });
            assert.ok(
              fonts.some((font) => font.family === "Mona Sans" && font.status === "loaded"),
              "Mona Sans loaded",
            );
            assert.ok(
              fonts.every((font) => font.status !== "error"),
              "no font load errors",
            );
            assert.equal(
              await page.locator('[data-testid="join-oneclick"]').getAttribute("href"),
              "/join/discord",
            );
            assert.equal(
              await page.locator('[data-testid="join-invite"]').getAttribute("href"),
              inviteUrl,
            );
            const presence = page.locator('[data-testid="join-widget-presence"]');
            assert.equal(await presence.count(), 1, "base retains presence at every fixture age");
            const populated = SCENARIOS[state].channels.length > 0;
            const text = await presence.innerText();
            assert.match(text, /42 members online/);
            assert.match(text, /In Together We Own now/i);
            assert.doesNotMatch(text, /as of the last update/i);
            if (populated) {
              const list = await page.locator('[data-testid="join-widget-channels"]').innerText();
              assert.match(list, /Stage Room/);
              assert.match(list, /Voice Lounge/);
              assert.doesNotMatch(text, /No voice channels open/);
            } else {
              assert.equal(await page.locator('[data-testid="join-widget-channels"]').count(), 0);
              assert.match(text, /No voice channels open right now/);
            }
            for (const name of MEMBER_NAMES) assert.ok(!text.includes(name));
            assert.equal(await page.locator("iframe").count(), 0, "preview stays opt-in");
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              "no horizontal overflow",
            );
            const name = `${renderer}-${state}-${width}.png`;
            await page.screenshot({ path: join(evidence, name), fullPage: true });
            written.add(name);
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
