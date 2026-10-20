// Independent acceptance contract. No database, account, or external requests.
// Browser command: A11Y_BROWSER_TESTS=true npx vitest run test/event-device-timezone.test.ts
// Register this suite with the a11y job's executed-case verifier in the combined PR.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";

const ORIGIN = "https://events.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKTREE = fileURLToPath(new URL("../", import.meta.url));
const BUTTON = /^show in my device timezone$/i;
const VIEWS = ["Hono", "Kit"] as const;
type View = (typeof VIEWS)[number];

// Literal expectations are independently calculated, not produced by app date helpers.
const CASES = [
  {
    name: "London summer to New York",
    instant: "2026-07-15T19:00:00.000Z",
    host: "Europe/London",
    device: "America/New_York",
    date: /15 July 2026|July 15,? 2026|2026-07-15/,
    time: /15:00|3:00\s*pm/i,
    offset: /(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/,
    hostText: "Wednesday, 15 July 2026 at 20:00 GMT+01:00 (Europe/London)",
  },
  {
    name: "winter event while device today is summer",
    instant: "2026-01-15T20:00:00.000Z",
    host: "Europe/London",
    device: "America/New_York",
    date: /15 January 2026|January 15,? 2026|2026-01-15/,
    time: /15:00|3:00\s*pm/i,
    offset: /(?:UTC|GMT)\s*[−-]0?5(?::?00)?\b(?![\d:])/,
    hostText: "Thursday, 15 January 2026 at 20:00 GMT+00:00 (Europe/London)",
  },
  {
    name: "next calendar day in Tokyo",
    instant: "2026-07-15T23:30:00.000Z",
    host: "America/New_York",
    device: "Asia/Tokyo",
    date: /16 July 2026|July 16,? 2026|2026-07-16/,
    time: /08:30|8:30\s*am/i,
    offset: /(?:UTC|GMT)\s*\+0?9(?::?00)?\b(?![\d:])/,
    hostText: "Wednesday, 15 July 2026 at 19:30 GMT-04:00 (America/New_York)",
  },
  {
    name: "first autumn fold instant",
    instant: "2026-11-01T05:30:00.000Z",
    host: "Europe/London",
    device: "America/New_York",
    date: /\b1 November 2026\b|\bNovember 1,? 2026\b|\b2026-11-01\b/,
    time: /01:30|1:30\s*am/i,
    offset: /(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/,
    hostText: "Sunday, 1 November 2026 at 05:30 GMT+00:00 (Europe/London)",
  },
  {
    name: "second autumn fold instant",
    instant: "2026-11-01T06:30:00.000Z",
    host: "Europe/London",
    device: "America/New_York",
    date: /\b1 November 2026\b|\bNovember 1,? 2026\b|\b2026-11-01\b/,
    time: /01:30|1:30\s*am/i,
    offset: /(?:UTC|GMT)\s*[−-]0?5(?::?00)?\b(?![\d:])/,
    hostText: "Sunday, 1 November 2026 at 06:30 GMT+00:00 (Europe/London)",
  },
  {
    name: "same zone remains explicitly device-labelled",
    instant: "2026-07-15T19:00:00.000Z",
    host: "Europe/London",
    device: "Europe/London",
    date: /15 July 2026|July 15,? 2026|2026-07-15/,
    time: /20:00|8:00\s*pm/i,
    offset: /(?:UTC|GMT)\s*\+0?1(?::?00)?\b(?![\d:])/,
    hostText: "Wednesday, 15 July 2026 at 20:00 GMT+01:00 (Europe/London)",
  },
] as const;
type ClockCase = (typeof CASES)[number];
type Failure =
  | "missing-intl"
  | "missing-formatter"
  | "constructor-throws"
  | "resolution-throws"
  | "missing-zone"
  | "invalid-zone"
  | "format-throws";
const FAILURES: Failure[] = [
  "missing-intl",
  "missing-formatter",
  "constructor-throws",
  "resolution-throws",
  "missing-zone",
  "invalid-zone",
  "format-throws",
];

function eventRow(clock: ClockCase): typeof events.$inferSelect {
  const start = new Date(clock.instant);
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a board.",
    startsAt: start,
    endsAt: new Date(start.getTime() + 7200_000),
    timezone: clock.host,
    location: "The lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
  };
}

const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile(
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ): { js: { code: string } };
};
let kitPromise:
  | Promise<{
      renderDetail(model: unknown): { head: string; body: string };
      client: string;
    }>
  | undefined;
function kitBundle() {
  kitPromise ??= (async () => {
    const scratch = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "device-timezone-",
      ),
    );
    try {
      const component = JSON.stringify(join(WORKTREE, "web/src/lib/EventDetail.svelte"));
      const serverEntry = join(scratch, "server.mjs");
      const clientEntry = join(scratch, "client.mjs");
      const outfile = join(scratch, "server-bundle.mjs");
      writeFileSync(
        serverEntry,
        `import {render} from 'svelte/server'; import Detail from ${component}; export const renderDetail = model => render(Detail, {props:{model}});`,
      );
      writeFileSync(
        clientEntry,
        `import {hydrate} from 'svelte'; import Detail from ${component}; hydrate(Detail, {target:document.getElementById('detail-root'),props:{model:window.__detailModel}});`,
      );
      const options = (generate: "server" | "client") => ({
        bundle: true,
        logLevel: "warning" as const,
        absWorkingDir: WORKTREE,
        tsconfigRaw: { compilerOptions: {} },
        nodePaths: [join(WORKTREE, "web/node_modules"), join(WORKTREE, "node_modules")],
        alias: { "#lib": join(WORKTREE, "web/src/lib") },
        plugins: [
          {
            name: `device-timezone-${generate}`,
            setup(plugin: import("esbuild").PluginBuild) {
              plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
                contents: compile(readFileSync(args.path, "utf8"), {
                  generate,
                  dev: false,
                  filename: args.path,
                }).js.code,
                loader: "js",
                resolveDir: dirname(args.path),
              }));
            },
          },
        ],
      });
      await build({
        ...options("server"),
        entryPoints: [serverEntry],
        platform: "node",
        format: "esm",
        outfile,
      });
      const server = await import(pathToFileURL(outfile).href);
      const client = await build({
        ...options("client"),
        entryPoints: [clientEntry],
        platform: "browser",
        conditions: ["browser"],
        format: "iife",
        write: false,
      });
      return {
        renderDetail: server.renderDetail as (model: unknown) => { head: string; body: string },
        client: client.outputFiles[0]!.text,
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return kitPromise;
}

async function renderFixture(view: View, clock: ClockCase) {
  const row = eventRow(clock);
  const env = {
    APP_URL: ORIGIN,
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: createMemorySessionStore(),
  } as unknown as Env;
  if (view === "Hono") {
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
    env.ADMIN_DB = drizzle(async (sql) => {
      if (sql.includes('from "rsvps"')) return { rows: [] };
      if (sql.includes('"event_key" ='))
        return {
          rows: [
            columns.map((key) =>
              row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
            ),
          ],
        };
      return { rows: [] };
    }) as unknown as Db;
    const response = await app.request(`/e/${KEY}`, {}, env);
    expect(response.status, "fixture must reach the real detail, not an error page").toBe(200);
    return { html: await response.text(), client: "" };
  }
  const store: KitEventDetailStore = {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => ({ ...row, goingCount: 0 }),
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: "",
    path: `/e/${KEY}`,
    env,
    session: { status: "guest", session: null },
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  expect(outcome.kind, "Kit fixture must resolve the real detail model").toBe("ok");
  if (outcome.kind !== "ok") throw new Error(`Unexpected detail outcome: ${outcome.kind}`);
  const bundle = await kitBundle();
  const { head, body } = bundle.renderDetail(outcome.model);
  const model = JSON.stringify(outcome.model).replace(/</g, "\\u003c");
  return {
    html: `<!doctype html><html lang="en"><head>${head}</head><body><div id="detail-root">${body}</div><script>window.__detailModel=${model}</script></body></html>`,
    client: bundle.client,
  };
}

for (const view of VIEWS) {
  describe(`${view} device timezone server contract`, () => {
    it("positive control: no-JS HTML retains the complete authoritative host instant", async () => {
      for (const clock of CASES) {
        const { html } = await renderFixture(view, clock);
        expect(html).toContain(`<time datetime="${clock.instant}">${clock.hostText}</time>`);
        expect(html).toContain(KEY);
        expect(html).toContain("event-ics");
        expect(html).toContain("event-google-calendar");
      }
    });
  });
}

// Same explicit Chromium opt-in used by the existing profile browser suites.
// The Builder must wire the executed-case verifier; a skipped browser run is not proof.
describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")(
  "event device timezone browser acceptance",
  () => {
    let browser: Browser;
    const contexts: BrowserContext[] = [];
    beforeAll(async () => {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
    });
    afterAll(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser?.close();
    });

    async function open(view: View, clock: ClockCase, failure?: Failure, javaScriptEnabled = true) {
      const fixture = await renderFixture(view, clock);
      const context = await browser.newContext({
        locale: "en-GB",
        timezoneId: clock.device,
        javaScriptEnabled,
        serviceWorkers: "block",
      });
      contexts.push(context);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.clock.setFixedTime(new Date("2026-07-15T12:00:00Z"));
      if (failure)
        await page.addInitScript((mode) => {
          const native = Intl.DateTimeFormat;
          if (mode === "missing-intl") {
            Object.defineProperty(window, "Intl", { value: undefined });
            return;
          }
          if (mode === "missing-formatter") {
            Object.defineProperty(Intl, "DateTimeFormat", { value: undefined });
            return;
          }
          const replacement = function (
            locales?: Intl.LocalesArgument,
            options?: Intl.DateTimeFormatOptions,
          ) {
            if (mode === "constructor-throws") throw new RangeError("Intl unavailable");
            const formatter = new native(locales, options);
            if (mode === "resolution-throws")
              formatter.resolvedOptions = () => {
                throw new Error("resolution unavailable");
              };
            if (mode === "missing-zone" || mode === "invalid-zone") {
              const resolved = formatter.resolvedOptions.bind(formatter);
              formatter.resolvedOptions = () => ({
                ...resolved(),
                timeZone: mode === "missing-zone" ? "" : "Invalid/Device",
              });
            }
            if (mode === "format-throws") {
              Object.defineProperty(formatter, "format", {
                value: () => {
                  throw new Error("format unavailable");
                },
              });
              formatter.formatToParts = () => {
                throw new Error("parts unavailable");
              };
            }
            return formatter;
          };
          Object.defineProperty(Intl, "DateTimeFormat", { value: replacement });
        }, failure);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) {
          await route.fulfill({ status: 204 });
          return;
        }
        if (url.pathname === `/e/${KEY}`) {
          await route.fulfill({ contentType: "text/html", body: fixture.html });
          return;
        }
        if (url.pathname === "/detail-client.js") {
          await route.fulfill({ contentType: "text/javascript", body: fixture.client });
          return;
        }
        const file = resolve(WORKTREE, "public", `.${url.pathname}`);
        if (file.startsWith(join(WORKTREE, "public") + "/")) {
          try {
            await route.fulfill({
              body: readFileSync(file),
              contentType: file.endsWith(".js")
                ? "text/javascript"
                : file.endsWith(".css")
                  ? "text/css"
                  : "application/octet-stream",
            });
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await route.fulfill({ status: 204 });
      });
      await page.goto(`${ORIGIN}/e/${KEY}`);
      if (view === "Kit" && javaScriptEnabled)
        await page.addScriptTag({ url: `${ORIGIN}/detail-client.js` });
      return { page, context, errors };
    }

    async function invariant(page: Page, clock: ClockCase) {
      return page.evaluate((instant) => {
        const host = document.querySelector(`time[datetime="${instant}"]`);
        return {
          host: host?.outerHTML,
          calendar: [
            ...document.querySelectorAll(
              'a[data-testid="event-ics"],a[data-testid="event-google-calendar"]',
            ),
          ].map((node) => node.outerHTML),
          schema: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
            (node) => node.textContent,
          ),
          forms: [...document.querySelectorAll("form")].map((node) => node.outerHTML),
        };
      }, clock.instant);
    }
    async function visibleText(page: Page) {
      return page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const texts: string[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (
            parent &&
            !parent.closest("script,style") &&
            parent.checkVisibility({ checkVisibilityCSS: true })
          ) {
            const text = node.textContent?.trim();
            if (text) texts.push(text);
          }
        }
        return texts;
      });
    }
    function addedText(before: string[], after: string[]) {
      const remaining = [...before];
      return after
        .filter((text) => {
          const index = remaining.indexOf(text);
          if (index < 0) return true;
          remaining.splice(index, 1);
          return false;
        })
        .join(" ")
        .replace(/\s+/g, " ");
    }
    async function guardSideEffects(page: Page) {
      const requests: string[] = [];
      page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
      await page.evaluate(() => {
        const effects: string[] = [];
        Object.defineProperty(window, "__timezoneEffects", { value: effects });
        const deny = (name: string) => () => {
          effects.push(name);
          throw new Error(`Forbidden local conversion effect: ${name}`);
        };
        for (const name of ["getItem", "setItem", "removeItem", "clear", "key"])
          Object.defineProperty(Storage.prototype, name, { value: deny(`storage.${name}`) });
        Object.defineProperty(document, "cookie", {
          get: () => {
            effects.push("cookie.read");
            return "";
          },
          set: deny("cookie.write"),
        });
        Object.defineProperty(window, "fetch", { value: deny("fetch") });
        Object.defineProperty(window, "XMLHttpRequest", { value: deny("xhr") });
        Object.defineProperty(window, "WebSocket", { value: deny("websocket") });
        Object.defineProperty(navigator, "sendBeacon", { value: deny("beacon") });
        Object.defineProperty(navigator, "geolocation", {
          value: {
            getCurrentPosition: deny("geolocation"),
            watchPosition: deny("geolocation.watch"),
          },
        });
      });
      return async () => {
        expect(await page.evaluate(() => Reflect.get(window, "__timezoneEffects"))).toEqual([]);
        expect(requests, "activation must not make any request, including telemetry").toEqual([]);
      };
    }
    async function activate(page: Page) {
      const button = page.getByRole("button", { name: BUTTON });
      expect(await button.count(), "missing explicit device-timezone activation").toBe(1);
      expect(await button.isVisible()).toBe(true);
      expect(await button.isEnabled()).toBe(true);
      expect(await button.evaluate((node) => node.tagName)).toBe("BUTTON");
      expect(await button.getAttribute("type")).toBe("button");
      for (let step = 0; step < 50; step++) {
        if (await button.evaluate((node) => node === document.activeElement)) break;
        await page.keyboard.press("Tab");
      }
      expect(
        await button.evaluate((node) => node === document.activeElement),
        "action must be reachable with Tab, not just programmatic focus",
      ).toBe(true);
      await page.keyboard.press("Enter");
    }

    for (const view of VIEWS) {
      it(`${view}: positive control, real no-JS browser keeps host schedule and links usable`, async () => {
        const { page, errors } = await open(view, CASES[0], undefined, false);
        expect(await page.locator(`time[datetime="${CASES[0].instant}"]`).first().innerText()).toBe(
          CASES[0].hostText,
        );
        expect(await page.locator('[data-testid="event-ics"]').count()).toBe(1);
        expect(await page.locator('[data-testid="event-google-calendar"]').count()).toBe(1);
        expect(errors).toEqual([]);
      });
      it(`${view}: page load does not convert, steal focus, or change the machine instant`, async () => {
        const { page, errors } = await open(view, CASES[0]);
        expect(await page.locator(`time[datetime="${CASES[0].instant}"]`).first().innerText()).toBe(
          CASES[0].hostText,
        );
        expect(await page.locator("body").innerText()).not.toContain(CASES[0].device);
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
        expect(errors).toEqual([]);
      });
      for (const clock of CASES) {
        it(`${view}: ${clock.name}`, async () => {
          const { page, context, errors } = await open(view, clock);
          const initial = await invariant(page, clock);
          const cookies = await context.cookies();
          const before = await visibleText(page);
          const assertNoEffects = await guardSideEffects(page);
          await activate(page);
          await expect
            .poll(async () => addedText(before, await visibleText(page)))
            .toMatch(clock.date);
          const result = addedText(before, await visibleText(page));
          expect(result).toMatch(/device|your (?:local |time)|my time/i);
          expect(result).toContain(clock.device);
          expect(result).toMatch(clock.time);
          expect(result).toMatch(clock.offset);
          expect(await invariant(page, clock)).toEqual(initial);
          expect(await context.cookies()).toEqual(cookies);
          await assertNoEffects();
          expect(errors).toEqual([]);
        });
      }
      for (const failure of FAILURES) {
        it(`${view}: ${failure} gives honest fallback, never a fabricated local time`, async () => {
          const clock = CASES[0];
          const { page, errors } = await open(view, clock, failure);
          const initial = await invariant(page, clock);
          const before = await visibleText(page);
          const assertNoEffects = await guardSideEffects(page);
          const button = page.getByRole("button", { name: BUTTON });
          const canActivate = (await button.count()) === 1 && (await button.isEnabled());
          // Early capability detection may disable/hide the action and give guidance
          // immediately. Otherwise the actual keyboard activation must surface it.
          if (canActivate) await activate(page);
          const guidance = async () =>
            canActivate
              ? addedText(before, await visibleText(page))
              : (await visibleText(page)).join(" ");
          await expect
            .poll(guidance)
            .toMatch(/unavailable|unable|could not|couldn't|cannot|can't|not supported/i);
          const result = await guidance();
          expect(result).toMatch(/host|shown above|calendar/i);
          expect(result).not.toContain("America/New_York");
          expect(result).not.toMatch(/15:00|3:00\s*pm|Invalid\/Device/i);
          expect(await invariant(page, clock)).toEqual(initial);
          await assertNoEffects();
          expect(errors, "Intl failures must not escape browser handlers").toEqual([]);
        });
      }
    }
  },
);
