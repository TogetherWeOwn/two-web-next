// Capture an ephemeral Tag gallery route inside the exact pinned Kit app, never a deployed route.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  DOTS,
  SOURCE_SHA,
  TAGS,
  VIEWPORTS,
  assertNoAxeViolations,
  assertSource,
  isAllowedRequest,
  parseArgs,
  summarizeLighthouse,
} from "./kit-tag-capture-guards.mjs";

if (!process.env.TOOLING_SHA) throw new Error("TOOLING_SHA is required");
const args = parseArgs(process.argv.slice(2));
const app = resolve(args.app);
const output = resolve(args.output);
const route = join(app, "web/src/routes/__tag_gallery_evidence");
const hooks = join(app, "web/src/hooks.server.ts");
const require = createRequire(join(app, "package.json"));
const { chromium } = require("playwright");
const { default: AxeBuilder } = require("@axe-core/playwright");
const tooling = resolve(import.meta.dirname, "..");
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (...a) => execFileSync("git", ["-C", app, ...a], { encoding: "utf8" }).trim();
const version = (name) =>
  JSON.parse(readFileSync(join(app, "node_modules", name, "package.json"), "utf8")).version;
const origin = "http://127.0.0.1:4180";
const url = `${origin}/__tag_gallery_evidence`;
const debugPort = 9340;
// The pin and a clean tree are verified before any fixture is written.
assertSource({ head: git("rev-parse", "HEAD"), status: git("status", "--porcelain") });
const originalHooks = readFileSync(hooks);
let server;
let browser;
let routeCreated = false;
try {
  mkdirSync(output, { recursive: true });
  mkdirSync(route); // Unique name: must not shadow any real app route.
  routeCreated = true;
  copyFileSync(join(tooling, "ci/kit-tag-capture-gallery.svelte"), join(route, "+page.svelte"));
  // The production dispatcher needs Workers bindings; bypassed only in this gallery.
  writeFileSync(hooks, "export const handle = ({ event, resolve }) => resolve(event);\n");
  server = spawn(
    process.execPath,
    [
      join(app, "web/node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "4180",
      "--strictPort",
    ],
    {
      cwd: join(app, "web"),
      // No secrets or DB: an unreachable loopback URL fails closed if a read is introduced.
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
  while (!ready && Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("Kit server exited before readiness");
    try {
      ready = (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      /* Retry until the bounded deadline. */
    }
    if (!ready) await delay(250);
  }
  if (!ready) throw new Error("Kit server readiness timed out");
  browser = await chromium.launch({
    headless: true,
    // Resolver rules also isolate Lighthouse, whose traffic bypasses Playwright routing.
    args: [
      `--remote-debugging-port=${debugPort}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ],
  });
  const lhPath = join(app, "node_modules/lighthouse/core/index.js");
  if (!existsSync(lhPath)) throw new Error("Locked lighthouse dependency is missing");
  const { default: lighthouse } = await import(pathToFileURL(lhPath).href);
  const results = [];
  for (const [name, width, height] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const problems = [];
    const blocked = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    await page.route("**/*", (r) => {
      if (isAllowedRequest(r.request().url(), origin)) return r.continue();
      blocked.push(r.request().url());
      return r.abort();
    });
    const response = await page.goto(url, { waitUntil: "networkidle" });
    if (!response?.ok()) throw new Error(`Gallery request failed: ${name}`);
    await page.evaluate(() => document.fonts.ready);
    for (const [attr, ids] of [
      ["data-tag", TAGS],
      ["data-dot", DOTS],
    ])
      for (const id of ids) {
        const row = page.locator(`[${attr}="${id}"]`);
        if ((await row.count()) !== 1 || !(await row.locator("span").first().isVisible()))
          throw new Error(`Missing ${attr}: ${id}`);
      }
    // Hydration must be real: the click handler only exists after the client mounts.
    await page.waitForSelector('main[data-hydrated="yes"]', { timeout: 5000 });
    await page.getByRole("button").click();
    if ((await page.getByRole("button").textContent())?.trim() !== "Clicked 1")
      throw new Error(`Hydration interaction failed: ${name}`);
    const axe = assertNoAxeViolations(await new AxeBuilder({ page }).analyze());
    await page.screenshot({ path: join(output, `tag-gallery-${name}.png`) });
    if (problems.length) throw new Error(`Page errors: ${problems.join("; ")}`);
    if (blocked.length) throw new Error(`Blocked external requests: ${blocked.join(", ")}`);
    const mobile = width < 800;
    const run = await lighthouse(url, {
      port: debugPort,
      output: "json",
      onlyCategories: ["performance", "accessibility"],
      formFactor: mobile ? "mobile" : "desktop",
      screenEmulation: { mobile, width, height, deviceScaleFactor: 1, disabled: false },
    });
    const lighthouseResult = summarizeLighthouse(run?.lhr);
    writeFileSync(join(output, `tag-gallery-${name}-lighthouse.json`), JSON.stringify(run.lhr));
    results.push({
      viewport: { width, height },
      tags: TAGS,
      dots: DOTS,
      hydrated: true,
      axe,
      lighthouse: lighthouseResult,
    });
    await page.close();
  }
  const provenance = {
    toolingSha: process.env.TOOLING_SHA,
    sourceSha: git("rev-parse", "HEAD"),
    expectedSourceSha: SOURCE_SHA,
    overlaid: false,
    fixture: "Ephemeral Kit route; production server hook replaced for capture",
    kitPolicy: "not evaluated; measurements are diagnostic only",
    hashes: Object.fromEntries([
      ...[
        "package-lock.json",
        "web/package-lock.json",
        "web/src/lib/Tag.svelte",
        "web/src/lib/LiveDot.svelte",
      ].map((p) => [p, hash(join(app, p))]),
      ...[
        "ci/kit-tag-capture.mjs",
        "ci/kit-tag-capture-guards.mjs",
        "ci/kit-tag-capture-gallery.svelte",
      ].map((p) => [p, hash(join(tooling, p))]),
    ]),
    versions: {
      node: process.version,
      browser: browser.version(),
      playwright: version("playwright"),
      axe: version("@axe-core/playwright"),
      lighthouse: version("lighthouse"),
    },
    runner: process.env.RUNNER_OS,
    runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    validation: results,
  };
  writeFileSync(
    join(output, "tag-gallery-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = new Promise((r) => server.once("exit", r));
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
