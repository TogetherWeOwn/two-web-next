// Join presence-state visual evidence harness (controller side).
//
// Adapted from the original harness at source SHA
// afbed516b6fdcd322d847317e4b95c42de7e95f1 (ci/join-presence-browser.test.mjs,
// read-only; never edited). This file lives in a separate controller checkout
// and renders a separately checked-out target application at an explicit root.
//
// Interface (all required, no defaults beyond the pinned application SHA):
//   APP_ROOT            absolute path of the target source checkout, with its
//                       dependencies installed and the Kit adapter already
//                       built (web/.svelte-kit/output). Must equal the cwd.
//   JOIN_EVIDENCE_DIR   absolute output directory for the screenshots.
//   JOIN_APP_SHA        optional override of the expected application SHA
//                       (default below); HEAD of APP_ROOT must equal it.
//
// Run from APP_ROOT:
//   node --import tsx --test <controller>/ci/join-state-evidence.test.mjs
//
// Output: 20 images named `<renderer>-<state>-<width>.png`, renderer in
// {hono,kit}, width in {1280,390}, state in {fresh-populated, stale-populated,
// stale-empty, expired, fresh-empty}. Fixture snapshots come from the target's
// own createDiscordWidgetHealth with an injected clock. Real Hono Join screen
// and the built Kit runtime render them; Kit data loads and hooks are
// substituted fixtures (no real auth/load stack is exercised). Every browser
// request is intercepted locally; nothing leaves the process.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { appGit, appImport } from "./join-state-evidence-source.mjs";
import { renderJoinFixtures } from "./join-state-render.mjs";

const APP_SHA = process.env.JOIN_APP_SHA ?? "60c47d13e96b254e71303f24e777932a0e506713";
const WIDTHS = [1280, 390];
const RENDERERS = ["hono", "kit"];
const STATES = ["fresh-populated", "stale-populated", "stale-empty", "expired", "fresh-empty"];

const origin = "http://join-state.test";
const inviteUrl = "https://discord.gg/invite";
const MEMBER_NAMES = ["private-member-one", "private-member-two"];

let appRoot;
let evidence;
let output;
let scratch;
let browser;
let fixtures = [];
const written = new Set();

before(async () => {
  assert.ok(process.env.APP_ROOT, "APP_ROOT is required");
  assert.ok(isAbsolute(process.env.APP_ROOT), "APP_ROOT must be absolute");
  appRoot = resolve(process.env.APP_ROOT);
  assert.equal(resolve(process.cwd()), appRoot, "cwd must equal APP_ROOT");
  assert.ok(process.env.JOIN_EVIDENCE_DIR, "JOIN_EVIDENCE_DIR is required");
  assert.ok(isAbsolute(process.env.JOIN_EVIDENCE_DIR), "JOIN_EVIDENCE_DIR must be absolute");
  evidence = resolve(process.env.JOIN_EVIDENCE_DIR);
  assert.match(APP_SHA, /^[0-9a-f]{40}$/, "expected application SHA");
  assert.equal(
    appGit(appRoot, "rev-parse", "HEAD"),
    APP_SHA,
    "APP_ROOT HEAD is the target application SHA",
  );
  assert.equal(
    appGit(appRoot, "status", "--porcelain", "--untracked-files=no"),
    "",
    "application tracked files unchanged",
  );
  output = join(appRoot, "web/.svelte-kit/output");
  assert.ok(existsSync(join(output, "server/index.js")), "built Kit output present");

  const pw = await appImport(appRoot, "playwright");
  const chromium = pw.chromium ?? pw.default?.chromium;
  ({ fixtures, scratch } = await renderJoinFixtures(appRoot, output));

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
      appGit(appRoot, "status", "--porcelain", "--untracked-files=no"),
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
            if (state === "expired") {
              assert.equal(await presence.count(), 0, "presence dropped at expiry");
              assert.equal(await page.locator('[data-testid="join-widget-load"]').count(), 1);
              assert.equal(await page.locator('[data-testid="join-widget-fallback"]').count(), 0);
            } else {
              const stale = state.startsWith("stale");
              const populated = state.endsWith("populated");
              const text = await presence.innerText();
              assert.match(text, /42 members online/);
              assert.match(text, stale ? /as of the last update/i : /In Together We Own now/i);
              if (stale) assert.doesNotMatch(text, /\bnow\b/i, "stale copy never says now");
              if (populated) {
                const list = await page.locator('[data-testid="join-widget-channels"]').innerText();
                assert.match(list, /Stage Room/);
                assert.match(list, /Voice Lounge/);
                assert.doesNotMatch(text, /No voice channels open/);
              } else {
                assert.equal(await page.locator('[data-testid="join-widget-channels"]').count(), 0);
                assert.match(
                  text,
                  stale
                    ? /No voice channels open as of the last update/
                    : /No voice channels open right now/,
                );
              }
              for (const name of MEMBER_NAMES) assert.ok(!text.includes(name));
            }
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
