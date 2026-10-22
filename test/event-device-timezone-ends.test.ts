// Independent acceptance contract for Ends device-timezone conversion. No database, account, or external requests.
// Browser command: A11Y_BROWSER_TESTS=true npx vitest run test/event-device-timezone-ends.test.ts
// Test-author owned: the Builder consumes this file without editing it; corrections return to the Test Author.
// Ends reuses the Starts mount shape verbatim (same button label, same binder, same
// unavailable-copy path); the mounts differ only by position and by button/status testids.
// Register this suite with the a11y job's executed-case verifier in the combined PR:
//   1. SUITES entry in ci/a11y-native-browser-suites.test.mjs,
//   2. a11y job step in .github/workflows/ci.yml (vitest JSON report + a11y-require-executed.mjs),
//   3. README.md Browser regressions table row.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
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

// Browser callbacks run in Chromium; keep their DOM surface local to this module.
interface BrowserElement {
  outerHTML: string;
  textContent: string | null;
  tagName: string;
  closest(selector: string): BrowserElement | null;
  checkVisibility(options: { checkVisibilityCSS: boolean }): boolean;
}
declare const window: typeof globalThis;
declare const document: {
  body: BrowserElement;
  activeElement: BrowserElement | null;
  querySelector(selector: string): BrowserElement | null;
  querySelectorAll(selector: string): Iterable<BrowserElement>;
  createTreeWalker(
    root: BrowserElement,
    whatToShow: number,
  ): { nextNode(): { parentElement: BrowserElement | null; textContent: string | null } | null };
};
declare const NodeFilter: { readonly SHOW_TEXT: number };

type TestEnv = Env & { ADMIN_DB?: Db };

const ORIGIN = "https://events.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKTREE = fileURLToPath(new URL("../", import.meta.url));
const BUTTON = /^show in my device timezone$/i;
const STARTS_BUTTON_TESTID = "event-device-timezone-starts-button";
const STARTS_STATUS_TESTID = "event-device-timezone-starts-status";
const ENDS_BUTTON_TESTID = "event-device-timezone-ends-button";
const ENDS_STATUS_TESTID = "event-device-timezone-ends-status";
const VIEWS = ["Hono", "Kit"] as const;
type View = (typeof VIEWS)[number];

// Literal expectations are independently calculated, not produced by app date helpers.
// Each instant below is the END of the fixture event; the start sits two hours earlier,
// so an Ends conversion that matched the start instant instead would fail the time pin.
// The date/time/offset/hostText rows mirror the Starts contract for the same instant:
// Ends conversion output must equal Starts behavior for the end instant.
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

const START_LEAD_MS = 7200_000;
function startIso(clock: ClockCase): string {
  return new Date(new Date(clock.instant).getTime() - START_LEAD_MS).toISOString();
}

function eventRow(clock: ClockCase): typeof events.$inferSelect {
  const end = new Date(clock.instant);
  const start = new Date(end.getTime() - START_LEAD_MS);
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a board.",
    startsAt: start,
    endsAt: end,
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

// The timezone instants are wall-clock pinned, so rows elapse in real time
// (the winter/summer cases are past today; the November fold cases follow).
// Both twins render an elapsed published row with the past share box, so
// link expectations branch on the same endsAt verdict the views use.
function isElapsed(clock: ClockCase): boolean {
  return eventRow(clock).endsAt <= new Date();
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
        "device-timezone-ends-",
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
            name: `device-timezone-ends-${generate}`,
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
  } as unknown as TestEnv;
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
    getEventFn: async () => ({ ...row, goingCount: 0, goingOccupancy: 0 }),
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

// The opening tag carrying a testid, whatever the attribute order. Fails when the
// testid is absent, sits on the wrong element, or the tag never closes.
function openingTag(html: string, testid: string, tag: "button" | "p"): string {
  const at = html.indexOf(`data-testid="${testid}"`);
  expect(at, `missing testid ${testid}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf(`<${tag}`, at);
  expect(open, `testid ${testid} must sit on a <${tag}>`).toBeGreaterThan(-1);
  const end = html.indexOf(">", open);
  expect(end, `unclosed <${tag}> for ${testid}`).toBeGreaterThan(at);
  return html.slice(open, end + 1);
}

for (const view of VIEWS) {
  describe(`${view} Ends device timezone server contract`, () => {
    it("serves the Starts and Ends mounts with button/status testids", async () => {
      for (const clock of CASES) {
        const { html } = await renderFixture(view, clock);
        const mounts = html.match(/data-event-device-timezone/g) ?? [];
        expect(mounts.length, "Starts and Ends each carry one mount").toBe(2);
        const startsTime = html.indexOf(`<time datetime="${startIso(clock)}">`);
        expect(startsTime, "Starts host time missing").toBeGreaterThan(-1);
        const endsTime = html.indexOf(`<time datetime="${clock.instant}">`);
        expect(endsTime, "Ends host time missing").toBeGreaterThan(-1);
        for (const testid of [STARTS_BUTTON_TESTID, ENDS_BUTTON_TESTID]) {
          const tag = openingTag(html, testid, "button");
          expect(tag).toContain('type="button"');
          expect(tag).toContain("hidden");
          const at = html.indexOf(`data-testid="${testid}"`);
          const label = html.slice(html.indexOf(">", at) + 1, html.indexOf("</button>", at));
          expect(label.trim()).toBe("Show in my device timezone");
        }
        for (const testid of [STARTS_STATUS_TESTID, ENDS_STATUS_TESTID]) {
          const tag = openingTag(html, testid, "p");
          expect(tag).toContain('role="status"');
          const at = html.indexOf(`data-testid="${testid}"`);
          const body = html.slice(html.indexOf(">", at) + 1, html.indexOf("</p>", at));
          expect(body.trim(), "fresh render never pre-fills a conversion").toBe("");
        }
        // Sibling order is the binder contract: each time precedes its own mount,
        // and the Starts mount precedes the Ends block.
        const startsButton = html.indexOf(STARTS_BUTTON_TESTID);
        const startsStatus = html.indexOf(STARTS_STATUS_TESTID);
        const endsButton = html.indexOf(ENDS_BUTTON_TESTID);
        const endsStatus = html.indexOf(ENDS_STATUS_TESTID);
        expect(startsTime).toBeLessThan(startsButton);
        expect(startsButton).toBeLessThan(startsStatus);
        expect(endsTime).toBeLessThan(endsButton);
        expect(endsButton).toBeLessThan(endsStatus);
        expect(startsStatus).toBeLessThan(endsTime);
      }
    });
    it("positive control: no-JS HTML retains both complete host instants with no pre-conversion", async () => {
      for (const clock of CASES) {
        const { html } = await renderFixture(view, clock);
        expect(html).toContain(`<time datetime="${clock.instant}">${clock.hostText}</time>`);
        expect(html).toContain(`<time datetime="${startIso(clock)}">`);
        expect(html).toContain(KEY);
        if (isElapsed(clock)) {
          // Elapsed rows honestly render the past share box: Copy link plus
          // the past-events way-forward, never calendar actions.
          const share = html.match(/<section class="event-share"[\s\S]*?<\/section>/)?.[0] ?? "";
          expect(share).toContain("Share this event");
          expect(share).not.toContain("Save the date");
          expect(share).toContain('data-testid="event-copy-link"');
          expect(share).toContain('href="/events/past">Browse past events</a>');
          expect(share).not.toContain('data-testid="event-ics"');
          expect(share).not.toContain('data-testid="event-google-calendar"');
        } else {
          expect(html).toContain("event-ics");
          expect(html).toContain("event-google-calendar");
        }
        expect(html).not.toContain("In your device timezone");
      }
    });
  });
}

// Same explicit Chromium opt-in used by the existing device-timezone browser suites.
// The Builder must wire the executed-case verifier; a skipped browser run is not proof.
describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")(
  "event device timezone ends browser acceptance",
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
        if (url.pathname === "/Detail-client.js") {
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
        await page.addScriptTag({ url: `${ORIGIN}/Detail-client.js` });
      return { page, context, errors };
    }

    async function invariant(page: Page, clock: ClockCase) {
      return page.evaluate(
        ({ start, end }: { start: string; end: string }) => {
          const hostStarts = document.querySelector(`time[datetime="${start}"]`);
          const hostEnds = document.querySelector(`time[datetime="${end}"]`);
          return {
            hostStarts: hostStarts?.outerHTML,
            hostEnds: hostEnds?.outerHTML,
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
        },
        { start: startIso(clock), end: clock.instant },
      );
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
    async function activateEnds(page: Page) {
      const button = page.getByTestId(ENDS_BUTTON_TESTID);
      expect(await button.count(), "missing explicit Ends device-timezone activation").toBe(1);
      expect(await button.innerText()).toMatch(BUTTON);
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
      it(`${view}: positive control, real no-JS browser keeps both host instants and hidden actions`, async () => {
        const clock = CASES[0];
        const { page, errors } = await open(view, clock, undefined, false);
        expect(await page.locator(`time[datetime="${clock.instant}"]`).first().innerText()).toBe(
          clock.hostText,
        );
        expect(
          await page
            .locator(`time[datetime="${startIso(clock)}"]`)
            .first()
            .count(),
        ).toBe(1);
        expect(await page.locator("dd[data-event-device-timezone] button[hidden]").count()).toBe(2);
        if (isElapsed(clock)) {
          // Elapsed rows honestly render the past share box: Copy link plus
          // the past-events way-forward stay usable, calendar actions are gone.
          expect(await page.locator('[data-testid="event-ics"]').count()).toBe(0);
          expect(await page.locator('[data-testid="event-google-calendar"]').count()).toBe(0);
          expect(await page.locator('[data-testid="event-copy-link"]').count()).toBe(1);
          expect(await page.getByRole("link", { name: "Browse past events" }).count()).toBe(1);
        } else {
          expect(await page.locator('[data-testid="event-ics"]').count()).toBe(1);
          expect(await page.locator('[data-testid="event-google-calendar"]').count()).toBe(1);
        }
        expect(errors).toEqual([]);
      });
      it(`${view}: page load does not convert, steal focus, or change the machine instant`, async () => {
        const { page, errors } = await open(view, CASES[0]);
        expect(await page.locator(`time[datetime="${CASES[0].instant}"]`).first().innerText()).toBe(
          CASES[0].hostText,
        );
        expect(await page.locator("body").innerText()).not.toContain(CASES[0].device);
        expect(await page.getByTestId(STARTS_STATUS_TESTID).innerText()).toBe("");
        expect(await page.getByTestId(ENDS_STATUS_TESTID).innerText()).toBe("");
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
        expect(errors).toEqual([]);
      });
      for (const clock of CASES) {
        it(`${view}: ends ${clock.name}`, async () => {
          const { page, context, errors } = await open(view, clock);
          expect(
            await page.getByRole("button", { name: BUTTON }).count(),
            "both mounts bind the same activation",
          ).toBe(2);
          const initial = await invariant(page, clock);
          const cookies = await context.cookies();
          const before = await visibleText(page);
          const assertNoEffects = await guardSideEffects(page);
          await activateEnds(page);
          await expect
            .poll(async () => addedText(before, await visibleText(page)))
            .toMatch(clock.date);
          const result = addedText(before, await visibleText(page));
          expect(result).toMatch(/device|your (?:local |time)|my time/i);
          expect(result).toContain(clock.device);
          expect(result).toMatch(clock.time);
          expect(result).toMatch(clock.offset);
          // Ends activation converts only the end instant: the Starts result stays empty.
          expect(await page.getByTestId(STARTS_STATUS_TESTID).innerText()).toBe("");
          expect(await page.getByTestId(ENDS_STATUS_TESTID).innerText()).toContain(clock.device);
          expect(await invariant(page, clock)).toEqual(initial);
          expect(await context.cookies()).toEqual(cookies);
          await assertNoEffects();
          expect(errors).toEqual([]);
        });
      }
      for (const failure of FAILURES) {
        it(`${view}: ends ${failure} gives honest fallback, never a fabricated local time`, async () => {
          const clock = CASES[0];
          const { page, errors } = await open(view, clock, failure);
          const initial = await invariant(page, clock);
          const before = await visibleText(page);
          const assertNoEffects = await guardSideEffects(page);
          const button = page.getByTestId(ENDS_BUTTON_TESTID);
          const canActivate = (await button.count()) === 1 && (await button.isEnabled());
          // Early capability detection may disable/hide the action and give guidance
          // immediately. Otherwise the actual keyboard activation must surface it.
          if (canActivate) await activateEnds(page);
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
