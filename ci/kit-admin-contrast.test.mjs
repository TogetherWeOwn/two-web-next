// Run after npm run build --prefix web. Actual Kit Server/respond, root layout,
// leaf components and generated styles; only hooks and data loads are fixtures.
// Admin intentionally has csr=false: the shipped islands still execute.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { build } from "esbuild";
import { chromium } from "playwright";
import { eventRow, featuredRow } from "../test/helpers/admin-validation-correction.ts";
import { buildEventCreateView } from "../src/admin/kit-event-create.ts";
import { resolveKitEventEdit } from "../src/admin/kit-event-edit.ts";
import { resolveKitFeaturedEdit } from "../src/admin/kit-featured-edit.ts";
import { EventFormPage, FeaturedFormPage } from "../src/admin/pages.tsx";
import { registerPlanningWindowBrowserAcceptance } from "../test/helpers/admin-event-planning-window-browser.ts";

registerPlanningWindowBrowserAcceptance(() => browser);

const output = resolve("web/.svelte-kit/output");
const evidence = process.env.KIT_ADMIN_CONTRAST_EVIDENCE_DIR;
const origin = "http://kit-admin.test";
let scratch;
let browser;
let server;
let fixtures;

before(async () => {
  scratch = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-admin-contrast-"),
  );
  const event = await resolveKitEventEdit(
    eventRow.eventKey,
    {},
    {
      db: {},
      get: async () => eventRow,
      list: async () => ({ rows: [], total: 0 }),
      now: new Date("2026-10-23T12:00:00Z"),
    },
  );
  const featured = await resolveKitFeaturedEdit("7", {
    db: {},
    get: async () => featuredRow,
    now: new Date("2026-10-23T12:00:00Z"),
  });
  assert.equal(event.kind, "ok");
  assert.equal(featured.kind, "ok");
  fixtures = [
    { name: "event-new", path: "/admin/events/new", data: buildEventCreateView() },
    { name: "event-edit", path: `/admin/events/${eventRow.eventKey}`, data: { view: event.view } },
    { name: "featured-new", path: "/admin/featured/new", data: {} },
    { name: "featured-edit", path: "/admin/featured/7", data: { view: featured.view } },
    // Degraded-widget dashboard: no database, both analytics sections omitted.
    // The actor comes from the page data because the fixture stubs the layout
    // guard; the resource cards and footer are the real AdminShell output.
    {
      name: "dashboard",
      path: "/admin",
      data: {
        actor: { username: "Moderator" },
        funnel: undefined,
        zeroSearches: undefined,
        retentionDays: 30,
      },
    },
  ];
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
        name: "offline-kit-admin-data",
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
  server = fixtureServer(() => data);
  await server.init({ env: {}, read: (file) => readFile(join(output, "client", file)) });
  for (const f of fixtures) {
    data = f.data;
    const response = await server.respond(new Request(origin + f.path), {
      getClientAddress: () => "127.0.0.1",
    });
    assert.equal(response.status, 200, f.path);
    f.html = await response.text();
    assert.match(f.html, /_app\/immutable\/assets\/0\.[^\"]+\.css/, "real root stylesheet linked");
    assert.doesNotMatch(f.html, /type="module"[^>]*>\s*import/, "admin stays server rendered");
  }
  browser = await chromium.launch({ headless: true });
  if (evidence) await mkdir(evidence, { recursive: true });
});

after(async () => {
  await browser?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

for (const width of [1280, 390]) {
  for (const name of ["event-new", "event-edit", "featured-new", "featured-edit", "dashboard"]) {
    test(`Kit admin contrast: ${name} at ${width}`, async () => {
      const f = fixtures.find((fixture) => fixture.name === name);
      const isDashboard = name === "dashboard";
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 800 },
      });
      const unexpected = [];
      const errors = [];
      try {
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== origin || route.request().method() !== "GET") {
            unexpected.push(url.pathname);
            return route.abort();
          }
          if (url.pathname === f.path)
            return route.fulfill({ contentType: "text/html", body: f.html });
          const directory = url.pathname.startsWith("/_app/")
            ? join(output, "client")
            : resolve("public");
          const asset = resolve(directory, url.pathname.slice(1));
          if (asset.startsWith(directory + "/") && /\.(css|js|woff2)$/.test(asset)) {
            return route.fulfill({
              contentType: asset.endsWith(".css")
                ? "text/css"
                : asset.endsWith(".js")
                  ? "text/javascript"
                  : "font/woff2",
              body: await readFile(asset),
            });
          }
          unexpected.push(url.pathname);
          return route.abort();
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(origin + f.path);
        if (isDashboard) {
          await page.locator('[data-testid="admin-actor"]').first().waitFor();
        } else {
          await page.locator("[data-event-editor]").first().waitFor();
        }
        if (isDashboard) {
          assert.equal(
            await page.locator(".card p").count(),
            4,
            "four resource-card descriptions are actually present",
          );
        } else {
          assert.equal(
            (await page.locator(".hint").count()) > 0,
            true,
            "help text is actually present",
          );
        }
        if (name === "event-new") assert.equal(await page.locator("fieldset label").count(), 3);
        const axe = new AxeBuilder({ page });
        if (isDashboard) {
          // Card descriptions and footer only: the card heading links carry
          // the UA dark-scheme link color with no author rule, which fails on
          // the light cards on pristine main too. That pre-existing defect is
          // recorded in docs/evidence/kit-admin-contrast/README.md, not
          // guarded here; this suite owns the surfaces the slice restyles.
          axe.include(".card p").include("footer");
        } else {
          axe.include(".hint").include("footer").include("fieldset");
        }
        const result = await axe.withRules(["color-contrast"]).analyze();
        const measured = await page
          .locator(
            isDashboard ? ".card p, footer" : ".hint, footer, fieldset label, fieldset legend",
          )
          .evaluateAll(
            (elements, cardContainer) =>
              elements.map((el) => ({
                text: el.textContent.trim(),
                color: getComputedStyle(el).color,
                background: getComputedStyle(el.closest(cardContainer) ?? document.body)
                  .backgroundColor,
              })),
            isDashboard ? ".card" : "fieldset",
          );
        if (evidence) {
          await page.screenshot({ path: join(evidence, `${name}-${width}.png`), fullPage: true });
          await writeFile(
            join(evidence, `${name}-${width}.json`),
            JSON.stringify(
              { violations: result.violations, incomplete: result.incomplete, measured },
              null,
              2,
            ),
          );
        }
        assert.deepEqual(unexpected, [], "no live or mutating requests");
        assert.deepEqual(errors, [], "shipped islands execute without errors");
        assert.deepEqual(
          result.incomplete,
          [],
          "contrast must be measurable, not an axe incomplete",
        );
        assert.deepEqual(
          result.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
          })),
          [],
        );
      } finally {
        await context.close();
      }
    });
  }
}

test("Hono light admin presentation keeps its original colors", async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const pages = [
      await EventFormPage({ mode: "new", values: {}, errors: {} }).toString(),
      await FeaturedFormPage({ mode: "new", values: {}, errors: {} }).toString(),
    ];
    const page = await context.newPage();
    let html;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/hono") return route.fulfill({ contentType: "text/html", body: html });
      if (url.pathname === "/styles.css")
        return route.fulfill({
          contentType: "text/css",
          body: await readFile("public/styles.css"),
        });
      return route.abort();
    });
    for (html of pages) {
      await page.goto(origin + "/hono");
      await page.locator(".hint").first().waitFor();
      assert.deepEqual(
        await page.locator("body").evaluate((el) => ({
          color: getComputedStyle(el).color,
          background: getComputedStyle(el).backgroundColor,
        })),
        { color: "rgb(22, 19, 15)", background: "rgb(244, 239, 230)" },
      );
      for (const selector of [".hint", "footer"]) {
        assert.equal(
          await page
            .locator(selector)
            .first()
            .evaluate((el) => getComputedStyle(el).color),
          "rgb(107, 98, 87)",
        );
      }
      if (await page.locator("fieldset").count()) {
        assert.deepEqual(
          await page
            .locator("fieldset")
            .first()
            .evaluate((el) => ({
              color: getComputedStyle(el).color,
              background: getComputedStyle(el).backgroundColor,
            })),
          { color: "rgb(22, 19, 15)", background: "rgb(255, 253, 248)" },
        );
      }
    }
  } finally {
    await context.close();
  }
});
