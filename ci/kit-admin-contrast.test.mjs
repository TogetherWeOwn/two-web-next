// Run after npm run build --prefix web. Actual Kit Server/respond, root layout,
// leaf components and generated styles; only hooks and data loads are fixtures.
// Admin intentionally has csr=false: the shipped islands still execute.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { build } from "esbuild";
import { chromium } from "playwright";
import { eventRow, featuredRow } from "../test/helpers/admin-validation-correction.ts";
import { buildEventCreateView } from "../src/admin/kit-event-create.ts";
import { resolveKitEventEdit } from "../src/admin/kit-event-edit.ts";
import { resolveKitFeaturedEdit } from "../src/admin/kit-featured-edit.ts";
import { EventFormPage, FeaturedFormPage } from "../src/admin/pages.tsx";
import { parseEventForm } from "../src/admin/validation-event-form.ts";
import { ValidationError } from "../src/admin/validation-shared.ts";

// Field errors from the real validator for one invalid submission, so the
// errors captures carry the copy and summary targets moderators actually see.
const invalidEvent = {
  title: "",
  starts_at: "not a date",
  timezone: "Europe/London",
  capacity: "-3",
};
function eventErrors() {
  try {
    parseEventForm(invalidEvent);
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
  throw new Error("fixture submission must be invalid");
}
const errorFixtures = new Set(["event-new-errors", "event-edit-invalid", "event-edit-errors"]);

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
  const populatedEvent = await resolveKitEventEdit(
    eventRow.eventKey,
    {},
    {
      db: {},
      get: async () => ({
        ...eventRow,
        accessibilityNotes: "Step-free side door; hearing loop fitted",
        organizer_name: "Jordan",
        join_url: "https://example.com/lobby",
        join_instructions: "Ask for the community table on level two",
      }),
      list: async () => ({ rows: [], total: 0 }),
    },
  );
  assert.equal(populatedEvent.kind, "ok");
  fixtures = [
    { name: "event-new", path: "/admin/events/new", data: buildEventCreateView() },
    {
      name: "event-edit-populated",
      path: `/admin/events/${eventRow.eventKey}`,
      data: { view: populatedEvent.view },
    },
    {
      name: "event-edit-errors",
      path: `/admin/events/${eventRow.eventKey}`,
      data: {
        view: {
          ...populatedEvent.view,
          hasErrors: true,
          errors: {
            accessibility_notes: "Keep accessibility notes to 1000 characters.",
            organizer_name: "Keep the organizer name to 500 characters.",
            join_url: "Enter a valid public HTTP or HTTPS link without sign-in credentials.",
            join_instructions: "Keep joining instructions to 5000 characters.",
          },
        },
      },
    },
    {
      name: "event-new-errors",
      path: "/admin/events/new",
      data: buildEventCreateView(invalidEvent, eventErrors()),
    },
    { name: "event-edit", path: `/admin/events/${eventRow.eventKey}`, data: { view: event.view } },
    {
      name: "event-edit-invalid",
      path: `/admin/events/${eventRow.eventKey}`,
      // A rejected POST re-renders the submitted input beside its errors. The
      // submission left Ends blank, so the saved end time must not show.
      data: {
        view: {
          ...event.view,
          values: { ...event.view.values, ...invalidEvent, ends_at: "" },
          hasErrors: true,
          errors: eventErrors(),
        },
      },
    },
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

// Named suite: the executed-count verifier admits only cases under this title.
describe("Kit admin contrast", () => {
  for (const width of [1280, 390]) {
    for (const name of [
      "event-new",
      "event-new-errors",
      "event-edit",
      "event-edit-invalid",
      "event-edit-populated",
      "event-edit-errors",
      "featured-new",
      "featured-edit",
      "dashboard",
    ]) {
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
          if (errorFixtures.has(name)) {
            assert.equal(
              (await page.locator("[data-admin-validation-summary] a").count()) > 0,
              true,
            );
            assert.equal((await page.locator(".field .error").count()) > 0, true);
          }
          const axe = new AxeBuilder({ page });
          if (isDashboard) {
            // Card descriptions and footer only: the card heading links carry
            // the UA dark-scheme link color with no author rule, which fails on
            // the light cards on pristine main too. That pre-existing defect is
            // recorded in docs/evidence/kit-admin-contrast/README.md, not
            // guarded here; this suite owns the surfaces the slice restyles.
            axe.include(".card p").include("footer");
          } else {
            axe
              .include(".hint")
              .include("footer")
              .include("fieldset")
              .include(".notice")
              .include(".field .error");
          }
          const result = await axe.withRules(["color-contrast"]).analyze();
          const measured = await page
            .locator(
              isDashboard
                ? ".card p, footer"
                : ".hint, footer, fieldset label, fieldset legend, .notice p, .notice a, .field .error",
            )
            .evaluateAll(
              (elements, cardContainer) =>
                elements.map((el) => ({
                  text: el.textContent.trim(),
                  color: getComputedStyle(el).color,
                  background: getComputedStyle(el.closest(cardContainer) ?? document.body)
                    .backgroundColor,
                })),
              isDashboard ? ".card" : "fieldset, .notice",
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
          if (errorFixtures.has(name)) {
            const link = page.locator("[data-admin-validation-summary] a").first();
            await link.focus();
            assert.deepEqual(
              await link.evaluate((el) => [
                el.matches(":focus-visible"),
                getComputedStyle(el).outlineColor,
              ]),
              // --color-lobby-focus (#ff9c36): a dark --ink outline would be 1.24:1 here.
              [true, "rgb(255, 156, 54)"],
              "summary link focus ring stays visible on the raised surface",
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
        await EventFormPage({
          mode: "new",
          values: invalidEvent,
          errors: eventErrors(),
        }).toString(),
      ];
      const page = await context.newPage();
      let html;
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/hono")
          return route.fulfill({ contentType: "text/html", body: html });
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
        if (await page.locator(".notice").count()) {
          assert.equal(
            await page
              .locator(".notice")
              .first()
              .evaluate((el) => getComputedStyle(el).backgroundColor),
            "rgb(255, 247, 237)",
          );
          assert.equal(
            await page
              .locator(".field .error")
              .first()
              .evaluate((el) => getComputedStyle(el).color),
            "rgb(154, 52, 18)",
          );
        }
      }
    } finally {
      await context.close();
    }
  });
});
