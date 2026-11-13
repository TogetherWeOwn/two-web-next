// Capture an ephemeral route inside the pinned Kit app, never a deployed route.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [appArg, outputArg] = process.argv.slice(2);
if (!appArg || !outputArg || process.argv.length !== 4)
  throw new Error("Expected app and output paths");
const app = resolve(appArg);
const output = resolve(outputArg);
const route = join(app, "web/src/routes/__state_glyph_evidence");
const hooks = join(app, "web/src/hooks.server.ts");
const originalHooks = readFileSync(hooks);
const require = createRequire(join(app, "package.json"));
const { chromium } = require("playwright");
const tooling = resolve(import.meta.dirname, "..");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (...args) => execFileSync("git", ["-C", app, ...args], { encoding: "utf8" }).trim();
const url = "http://127.0.0.1:4179/__state_glyph_evidence";
let server;
let browser;
let routeCreated = false;
try {
  mkdirSync(output, { recursive: true });
  // The unique fixture route must not shadow any real app route.
  mkdirSync(route);
  routeCreated = true;
  copyFileSync(join(tooling, "ci/state-glyph-gallery.svelte"), join(route, "+page.svelte"));
  // The production dispatcher routes unknown paths to Hono and needs Workers
  // bindings. Bypass it only in this disposable gallery; this is not hook evidence.
  writeFileSync(hooks, "export const handle = ({ event, resolve }) => resolve(event);\n");
  server = spawn(
    process.execPath,
    [
      join(app, "web/node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "4179",
      "--strictPort",
    ],
    {
      cwd: join(app, "web"),
      // Wrangler requires a local Hyperdrive URL even though this fixture never reads the DB.
      // An unreachable loopback endpoint fails closed if a database read is introduced.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "development",
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB: "postgres://127.0.0.1:1/evidence",
      },
      stdio: "inherit",
    },
  );
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("Kit server exited before readiness");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for the bounded readiness deadline. */
    }
    await delay(250);
  }
  if (!ready) throw new Error("Kit server readiness timed out");
  browser = await chromium.launch({ headless: true });
  const results = [];
  for (const [name, width, height] of [
    ["desktop", 1280, 800],
    ["mobile", 390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.route("**/*", (request) => {
      const target = new URL(request.request().url());
      return target.origin === "http://127.0.0.1:4179" ? request.continue() : request.abort();
    });
    const response = await page.goto(url, { waitUntil: "networkidle" });
    if (!response?.ok()) throw new Error(`Gallery request failed: ${name}`);
    await page.evaluate(() => document.fonts.ready);
    for (const state of ["upcoming", "live", "mine", "past"]) {
      const row = page.locator(`[data-state="${state}"]`);
      if ((await row.count()) !== 1 || !(await row.locator("span").isVisible()))
        throw new Error(`Missing state text: ${state}`);
      const glyph = row.locator("svg");
      if ((await glyph.count()) !== 1 || (await glyph.isVisible()) !== width > 390)
        throw new Error(`Unexpected glyph visibility: ${name}/${state}`);
    }
    await page.screenshot({ path: join(output, `state-glyph-${name}.png`) });
    results.push({
      viewport: { width, height },
      states: ["upcoming", "live", "mine", "past"],
      glyphsVisible: width > 390,
    });
    await page.close();
  }
  const provenance = {
    toolingSha: process.env.TOOLING_SHA,
    pin: git("rev-parse", "HEAD"),
    glyph: "6d3b36f0c8675405d9bf22494c379682cedbe847",
    integrationTree: git("write-tree"),
    overlaid: true,
    fixture: "Ephemeral Kit route and root layout; production server hook replaced for capture",
    hashes: Object.fromEntries(
      ["package-lock.json", "web/package-lock.json"]
        .map((p) => [p, hash(join(app, p))])
        .concat(
          [
            ".github/workflows/state-glyph-evidence.yml",
            "ci/state-glyph-assemble.mjs",
            "ci/state-glyph-capture.mjs",
            "ci/state-glyph-gallery.svelte",
          ].map((p) => [p, hash(join(tooling, p))]),
        ),
    ),
    node: process.version,
    browser: browser.version(),
    runner: process.env.RUNNER_OS,
    runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    validation: results,
  };
  writeFileSync(
    join(output, "state-glyph-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await Promise.race([stopped, delay(5000)]);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await stopped;
      }
    }
    if (routeCreated) {
      writeFileSync(hooks, originalHooks);
      rmSync(route, { recursive: true, force: true });
    }
  }
}
