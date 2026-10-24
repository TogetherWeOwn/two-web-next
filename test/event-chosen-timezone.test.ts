// Independent acceptance contract for comparing the scheduled range in a chosen
// timezone. No database, account, or external requests.
// Browser command: A11Y_BROWSER_TESTS=true npx vitest run test/event-chosen-timezone.test.ts
// Test-author owned: the Builder consumes this file without editing it; corrections
// return to the Test Author. Register this suite with the a11y job's
// executed-case verifier in the combined PR:
//   1. SUITES entry in ci/a11y-native-browser-suites.test.mjs with title
//      "event chosen timezone browser acceptance" and minimum 30,
//   2. a11y job step in .github/workflows/ci.yml (vitest JSON report + verifier),
//   3. README.md Browser regressions table row.
// Contract: one [data-event-chosen-timezone] mount per detail page carries a labelled
// bounded native input (event-chosen-timezone-input), compact examples
// (event-chosen-timezone-examples), an explicit Compare action
// (event-chosen-timezone-button) and a polite empty-until-activation result
// (event-chosen-timezone-status). The mount shows BOTH start and end instants in
// the chosen zone with per-instant offsets. Device mounts stay untouched.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const INPUT_TESTID = "event-chosen-timezone-input";
const BUTTON_TESTID = "event-chosen-timezone-button";
const STATUS_TESTID = "event-chosen-timezone-status";
const EXAMPLES_TESTID = "event-chosen-timezone-examples";
const COMPARE = /compare/i;
const VIEWS = ["Hono", "Kit"] as const;
type View = (typeof VIEWS)[number];

// Literal expectations are independently calculated, not produced by app date helpers.
// Device differs from chosen in every case: a device-zone leak fails the time pin.
const CASES = [
  {
    name: "London summer range to New York",
    start: "2026-07-15T19:00:00.000Z",
    end: "2026-07-15T21:00:00.000Z",
    host: "Europe/London",
    chosen: "America/New_York",
    device: "Asia/Tokyo",
    hostStart: "Wednesday, 15 July 2026 at 20:00 GMT+01:00 (Europe/London)",
    hostEnd: "Wednesday, 15 July 2026 at 22:00 GMT+01:00 (Europe/London)",
    startDate: /15 July 2026|July 15,? 2026|2026-07-15/,
    startTime: /15:00|3:00\s*pm/i,
    startOffset: /(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/,
    endDate: /15 July 2026|July 15,? 2026|2026-07-15/,
    endTime: /17:00|5:00\s*pm/i,
    endOffset: /(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/,
  },
  {
    name: "next calendar day in Tokyo",
    start: "2026-07-15T23:30:00.000Z",
    end: "2026-07-16T01:30:00.000Z",
    host: "America/New_York",
    chosen: "Asia/Tokyo",
    device: "Europe/London",
    hostStart: "Wednesday, 15 July 2026 at 19:30 GMT-04:00 (America/New_York)",
    hostEnd: "Wednesday, 15 July 2026 at 21:30 GMT-04:00 (America/New_York)",
    startDate: /16 July 2026|July 16,? 2026|2026-07-16/,
    startTime: /08:30|8:30\s*am/i,
    startOffset: /(?:UTC|GMT)\s*\+0?9(?::?00)?\b(?![\d:])/,
    endDate: /16 July 2026|July 16,? 2026|2026-07-16/,
    endTime: /10:30|10:30\s*am/i,
    endOffset: /(?:UTC|GMT)\s*\+0?9(?::?00)?\b(?![\d:])/,
  },
  {
    name: "autumn fold span shows one wall time with two offsets",
    start: "2026-11-01T05:30:00.000Z",
    end: "2026-11-01T06:30:00.000Z",
    host: "Europe/London",
    chosen: "America/New_York",
    device: "Asia/Tokyo",
    hostStart: "Sunday, 1 November 2026 at 05:30 GMT+00:00 (Europe/London)",
    hostEnd: "Sunday, 1 November 2026 at 06:30 GMT+00:00 (Europe/London)",
    startDate: /\b1 November 2026\b|\bNovember 1,? 2026\b|\b2026-11-01\b/,
    startTime: /01:30|1:30\s*am/i,
    startOffset: /(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/,
    endDate: /\b1 November 2026\b|\bNovember 1,? 2026\b|\b2026-11-01\b/,
    endTime: /01:30|1:30\s*am/i,
    endOffset: /(?:UTC|GMT)\s*[−-]0?5(?::?00)?\b(?![\d:])/,
  },
  {
    name: "spring gap-adjacent span skips the missing hour",
    start: "2026-03-08T06:30:00.000Z",
    end: "2026-03-08T07:30:00.000Z",
    host: "Europe/London",
    chosen: "America/New_York",
    device: "Asia/Tokyo",
    hostStart: "Sunday, 8 March 2026 at 06:30 GMT+00:00 (Europe/London)",
    hostEnd: "Sunday, 8 March 2026 at 07:30 GMT+00:00 (Europe/London)",
    startDate: /\b8 March 2026\b|\bMarch 8,? 2026\b|\b2026-03-08\b/,
    startTime: /01:30|1:30\s*am/i,
    startOffset: /(?:UTC|GMT)\s*[−-]0?5(?::?00)?\b(?![\d:])/,
    endDate: /\b8 March 2026\b|\bMarch 8,? 2026\b|\b2026-03-08\b/,
    endTime: /03:30|3:30\s*am/i,
    endOffset: /(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/,
  },
  {
    name: "Kathmandu quarter-hour with rollover",
    start: "2026-07-15T19:00:00.000Z",
    end: "2026-07-15T21:00:00.000Z",
    host: "Europe/London",
    chosen: "Asia/Kathmandu",
    device: "America/New_York",
    hostStart: "Wednesday, 15 July 2026 at 20:00 GMT+01:00 (Europe/London)",
    hostEnd: "Wednesday, 15 July 2026 at 22:00 GMT+01:00 (Europe/London)",
    startDate: /16 July 2026|July 16,? 2026|2026-07-16/,
    startTime: /00:45|12:45\s*am/i,
    startOffset: /(?:UTC|GMT)\s*\+0?5:45\b/,
    endDate: /16 July 2026|July 16,? 2026|2026-07-16/,
    endTime: /02:45|2:45\s*am/i,
    endOffset: /(?:UTC|GMT)\s*\+0?5:45\b/,
  },
  {
    name: "same zone stays explicitly chosen-labelled",
    start: "2026-07-15T19:00:00.000Z",
    end: "2026-07-15T21:00:00.000Z",
    host: "Europe/London",
    chosen: "Europe/London",
    device: "America/New_York",
    hostStart: "Wednesday, 15 July 2026 at 20:00 GMT+01:00 (Europe/London)",
    hostEnd: "Wednesday, 15 July 2026 at 22:00 GMT+01:00 (Europe/London)",
    startDate: /15 July 2026|July 15,? 2026|2026-07-15/,
    startTime: /20:00|8:00\s*pm/i,
    startOffset: /(?:UTC|GMT)\s*\+0?1(?::?00)?\b(?![\d:])/,
    endDate: /15 July 2026|July 15,? 2026|2026-07-15/,
    endTime: /22:00|10:00\s*pm/i,
    endOffset: /(?:UTC|GMT)\s*\+0?1(?::?00)?\b(?![\d:])/,
  },
  {
    name: "different chosen dates across midnight",
    start: "2026-07-16T02:00:00.000Z",
    end: "2026-07-16T06:00:00.000Z",
    host: "Europe/London",
    chosen: "America/New_York",
    device: "Asia/Tokyo",
    hostStart: "Thursday, 16 July 2026 at 03:00 GMT+01:00 (Europe/London)",
    hostEnd: "Thursday, 16 July 2026 at 07:00 GMT+01:00 (Europe/London)",
    startDate: /15 July 2026|July 15,? 2026|2026-07-15/,
    startTime: /22:00|10:00\s*pm/i,
    startOffset: /(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/,
    endDate: /16 July 2026|July 16,? 2026|2026-07-16/,
    endTime: /02:00|2:00\s*am/i,
    endOffset: /(?:UTC|GMT)\s*[−-]0?4(?::?00)?\b(?![\d:])/,
  },
] as const;
type RangeCase = (typeof CASES)[number];
type ZoneFailure = "malformed" | "overlong" | "unsupported" | "empty";
const ZONE_FAILURES: Array<{ mode: ZoneFailure; value: string }> = [
  { mode: "malformed", value: "Not/AZone!!" },
  { mode: "overlong", value: `Europe/London${"A".repeat(120)}` },
  { mode: "unsupported", value: "Mars/Olympus_Mons" },
  { mode: "empty", value: "" },
];
type IntlFailure = "missing-intl" | "missing-formatter" | "constructor-throws" | "format-throws";
const INTL_FAILURES: IntlFailure[] = [
  "missing-intl",
  "missing-formatter",
  "constructor-throws",
  "format-throws",
];

function eventRow(range: RangeCase): typeof events.$inferSelect {
  const start = new Date(range.start);
  const end = new Date(range.end);
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Chess night",
    game: "Chess",
    description: "Bring a board.",
    startsAt: start,
    endsAt: end,
    timezone: range.host,
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
        "chosen-timezone-",
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
            name: `chosen-timezone-${generate}`,
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

async function renderFixture(view: View, range: RangeCase) {
  const row = eventRow(range);
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

function openingTag(html: string, testid: string, tag: string): string {
  const at = html.indexOf(`data-testid="${testid}"`);
  expect(at, `missing testid ${testid}`).toBeGreaterThan(-1);
  const open = html.lastIndexOf(`<${tag}`, at);
  expect(open, `testid ${testid} must sit on a <${tag}>`).toBeGreaterThan(-1);
  const end = html.indexOf(">", open);
  expect(end, `unclosed <${tag}> for ${testid}`).toBeGreaterThan(at);
  return html.slice(open, end + 1);
}

for (const view of VIEWS) {
  describe(`${view} chosen timezone server contract`, () => {
    it("positive control: no-JS HTML retains both host instants and calendar links", async () => {
      for (const range of CASES) {
        const { html } = await renderFixture(view, range);
        expect(html).toContain(`<time datetime="${range.start}">${range.hostStart}</time>`);
        expect(html).toContain(`<time datetime="${range.end}">${range.hostEnd}</time>`);
        expect(html).toContain(KEY);
        expect(html).toContain("event-ics");
        expect(html).toContain("event-google-calendar");
        expect(html).not.toContain("In America/New_York");
        expect(html).not.toContain("In Asia/Tokyo");
      }
    });

    it("positive control: existing device-time actions stay untouched", async () => {
      for (const range of CASES) {
        const { html } = await renderFixture(view, range);
        for (const testid of [
          "event-device-timezone-starts-button",
          "event-device-timezone-ends-button",
        ]) {
          const tag = openingTag(html, testid, "button");
          expect(tag).toContain('type="button"');
          expect(tag).toContain("hidden");
        }
        for (const testid of [
          "event-device-timezone-starts-status",
          "event-device-timezone-ends-status",
        ]) {
          const tag = openingTag(html, testid, "p");
          expect(tag).toContain('role="status"');
        }
      }
    });

    it("serves one labelled bounded chosen-zone mount with examples and Compare action", async () => {
      for (const range of CASES) {
        const { html } = await renderFixture(view, range);
        const mounts = html.match(/data-event-chosen-timezone/g) ?? [];
        expect(mounts.length, "exactly one chosen-range mount per detail page").toBe(1);

        const inputTag = openingTag(html, INPUT_TESTID, "input");
        expect(inputTag).toContain("hidden");
        const max = /maxlength="(\d+)"/.exec(inputTag)?.[1];
        expect(max, "input must carry a bounded maxlength").toBeDefined();
        expect(Number(max)).toBeGreaterThanOrEqual(32);
        expect(Number(max)).toBeLessThanOrEqual(128);
        expect(Number(max)).toBeLessThanOrEqual(100 + 28);
        // Native text entry, not a picker widget or remote combobox.
        expect(inputTag).not.toContain('role="combobox"');
        if (/type="/.test(inputTag)) expect(inputTag).toMatch(/type="(text|search)"/);

        const labelAt = html.indexOf("<label");
        expect(labelAt, "chosen input must have a visible label").toBeGreaterThan(-1);
        const mountAt = html.indexOf("data-event-chosen-timezone");
        const labelSlice = html.slice(Math.max(0, mountAt - 2000), html.indexOf(INPUT_TESTID));
        expect(labelSlice).toMatch(/<label[^>]*>.*timezone.*<\/label>/is);

        const examplesAt = html.indexOf(`data-testid="${EXAMPLES_TESTID}"`);
        expect(examplesAt, "compact examples must be served").toBeGreaterThan(-1);
        const examplesBody = html.slice(
          html.indexOf(">", examplesAt) + 1,
          html.indexOf("</", examplesAt),
        );
        expect(examplesBody.length, "examples stay compact").toBeLessThan(300);
        expect(examplesBody).toMatch(/Europe\/London|America\/New_York|Asia\/Tokyo/);

        const buttonTag = openingTag(html, BUTTON_TESTID, "button");
        expect(buttonTag).toContain('type="button"');
        expect(buttonTag).toContain("hidden");
        const buttonAt = html.indexOf(`data-testid="${BUTTON_TESTID}"`);
        const buttonLabel = html.slice(
          html.indexOf(">", buttonAt) + 1,
          html.indexOf("</button>", buttonAt),
        );
        expect(buttonLabel.trim()).toMatch(COMPARE);

        const statusTag = openingTag(html, STATUS_TESTID, "p");
        expect(statusTag).toContain('role="status"');
        expect(statusTag).toContain('aria-live="polite"');
        const statusAt = html.indexOf(`data-testid="${STATUS_TESTID}"`);
        const statusBody = html.slice(
          html.indexOf(">", statusAt) + 1,
          html.indexOf("</p>", statusAt),
        );
        expect(statusBody.trim(), "fresh render never pre-fills a comparison").toBe("");

        // Order is the binder contract: host times and device mounts first, then
        // the single chosen-range mount after the Ends block.
        const startsTime = html.indexOf(`<time datetime="${range.start}">`);
        const endsTime = html.indexOf(`<time datetime="${range.end}">`);
        const endsStatus = html.indexOf("event-device-timezone-ends-status");
        const chosenInput = html.indexOf(INPUT_TESTID);
        const chosenButton = html.indexOf(BUTTON_TESTID);
        const chosenStatus = html.indexOf(STATUS_TESTID);
        expect(startsTime).toBeGreaterThan(-1);
        expect(endsTime).toBeGreaterThan(-1);
        expect(endsStatus).toBeLessThan(chosenInput);
        expect(chosenInput).toBeLessThan(chosenButton);
        expect(chosenButton).toBeLessThan(chosenStatus);
      }
    });

    it("shipped island bytes carry the chosen mount (source and minified agree)", async () => {
      const islandDir = join(WORKTREE, "public", "islands");
      const shipped = readdirSync(islandDir)
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFileSync(join(islandDir, name), "utf8"));
      expect(
        shipped.some((bytes) => bytes.includes("data-event-chosen-timezone")),
        "at least one shipped island must bind the chosen mount; regenerate with npm run build:assets",
      ).toBe(true);
      expect(
        shipped.some((bytes) => bytes.includes(INPUT_TESTID) && bytes.includes(BUTTON_TESTID)),
        "shipped bytes must address the chosen input and Compare action",
      ).toBe(true);
      const sources: string[] = [];
      for (const name of readdirSync(join(WORKTREE, "assets", "islands"))) {
        if (name.endsWith(".js"))
          sources.push(readFileSync(join(WORKTREE, "assets", "islands", name), "utf8"));
      }
      sources.push(readFileSync(join(WORKTREE, "assets", "event-device-timezone.ts"), "utf8"));
      try {
        sources.push(readFileSync(join(WORKTREE, "assets", "event-chosen-timezone.ts"), "utf8"));
      } catch {
        // Dedicated source is optional when the shared formatter carries the range.
      }
      expect(
        sources.some(
          (text) =>
            text.includes("data-event-chosen-timezone") ||
            text.includes("eventRangeInChosenTimezone"),
        ),
        "a reviewed assets/ source must carry the chosen logic; public/ is build output only",
      ).toBe(true);
    });

    it("device-timezone guide distinguishes chosen instants from device clock helpers", async () => {
      const guide = readFileSync(join(WORKTREE, "docs", "event-device-timezone.md"), "utf8");
      expect(guide).toMatch(/chosen/i);
      expect(guide).toMatch(/device/i);
      expect(guide).toMatch(/IANA|identifier/i);
      expect(guide).toMatch(/start.*end|both|range/is);
    });
  });
}

// Same explicit Chromium opt-in used by the existing device-timezone browser suites.
// The Builder must wire the executed-case verifier; a skipped browser run is not proof.
describe.skipIf(process.env.A11Y_BROWSER_TESTS !== "true")(
  "event chosen timezone browser acceptance",
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

    async function open(
      view: View,
      range: RangeCase,
      failure?: IntlFailure,
      javaScriptEnabled = true,
    ) {
      const fixture = await renderFixture(view, range);
      const context = await browser.newContext({
        locale: "en-GB",
        timezoneId: range.device,
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

    async function invariant(page: Page, range: RangeCase) {
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
        { start: range.start, end: range.end },
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
        Object.defineProperty(window, "__chosenEffects", { value: effects });
        const deny = (name: string) => () => {
          effects.push(name);
          throw new Error(`Forbidden chosen-zone effect: ${name}`);
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
        for (const name of ["setTimeout", "setInterval", "requestAnimationFrame"] as const) {
          const original = (window as unknown as Record<string, unknown>)[name];
          Object.defineProperty(window, name, {
            value: (...args: unknown[]) => {
              effects.push(`timer.${name}`);
              return (original as (...a: unknown[]) => unknown)(...args);
            },
          });
        }
      });
      return async () => {
        expect(await page.evaluate(() => Reflect.get(window, "__chosenEffects"))).toEqual([]);
        expect(requests, "activation must not make any request, including telemetry").toEqual([]);
      };
    }
    async function fillChosen(page: Page, zone: string) {
      const input = page.getByTestId(INPUT_TESTID);
      expect(await input.count(), "missing labelled chosen-zone input").toBe(1);
      expect(await input.evaluate((node) => node.tagName)).toBe("INPUT");
      expect(await input.isVisible()).toBe(true);
      expect(await input.isEditable()).toBe(true);
      await input.fill(zone);
    }
    async function activateChosen(page: Page) {
      const button = page.getByTestId(BUTTON_TESTID);
      expect(await button.count(), "missing explicit Compare times action").toBe(1);
      expect(await button.innerText()).toMatch(COMPARE);
      expect(await button.isVisible()).toBe(true);
      expect(await button.isEnabled()).toBe(true);
      expect(await button.evaluate((node) => node.tagName)).toBe("BUTTON");
      expect(await button.getAttribute("type")).toBe("button");
      for (let step = 0; step < 60; step++) {
        if (await button.evaluate((node) => node === document.activeElement)) break;
        await page.keyboard.press("Tab");
      }
      expect(
        await button.evaluate((node) => node === document.activeElement),
        "Compare action must be reachable with Tab, not just programmatic focus",
      ).toBe(true);
      await page.keyboard.press("Enter");
    }

    for (const view of VIEWS) {
      it(`${view}: positive control, real no-JS browser keeps host schedule and links usable`, async () => {
        const range = CASES[0];
        const { page, errors } = await open(view, range, undefined, false);
        expect(await page.locator(`time[datetime="${range.start}"]`).first().innerText()).toBe(
          range.hostStart,
        );
        expect(await page.locator(`time[datetime="${range.end}"]`).first().innerText()).toBe(
          range.hostEnd,
        );
        expect(await page.locator('[data-testid="event-ics"]').count()).toBe(1);
        expect(await page.locator('[data-testid="event-google-calendar"]').count()).toBe(1);
        // CONTROL only: host schedule and calendar links survive without JS.
        // The chosen-controls-hidden pin lives in the server contract, which is
        // RED until the Builder serves the mount.
        expect(errors).toEqual([]);
      });
      it(`${view}: page load does not convert, steal focus, or change the machine instant`, async () => {
        const range = CASES[0];
        const { page, errors } = await open(view, range);
        expect(await page.locator(`time[datetime="${range.start}"]`).first().innerText()).toBe(
          range.hostStart,
        );
        expect(await page.getByTestId(STATUS_TESTID).innerText()).toBe("");
        expect(await page.locator("body").innerText()).not.toContain("GMT-04:00");
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
        expect(errors).toEqual([]);
      });
      it(`${view}: positive control, device actions still convert one instant each`, async () => {
        const range = CASES[0];
        const { page, errors } = await open(view, range);
        const starts = page.getByTestId("event-device-timezone-starts-button");
        expect(await starts.count()).toBe(1);
        await starts.click();
        await expect
          .poll(() => page.getByTestId("event-device-timezone-starts-status").innerText())
          .toMatch(/device|your (?:local |time)|my time/i);
        expect(await page.getByTestId("event-device-timezone-ends-status").innerText()).toBe("");
        expect(errors).toEqual([]);
      });
      for (const range of CASES) {
        it(`${view}: ${range.name}`, async () => {
          const { page, context, errors } = await open(view, range);
          const initial = await invariant(page, range);
          const cookies = await context.cookies();
          const before = await visibleText(page);
          const assertNoEffects = await guardSideEffects(page);
          await fillChosen(page, range.chosen);
          // Typing alone never converts: the result appears only on request.
          expect(await page.getByTestId(STATUS_TESTID).innerText()).toBe("");
          await activateChosen(page);
          await expect
            .poll(async () => addedText(before, await visibleText(page)))
            .toMatch(range.startDate);
          const result = addedText(before, await visibleText(page));
          expect(result).toContain(range.chosen);
          expect(result).toMatch(range.startDate);
          expect(result).toMatch(range.startTime);
          expect(result).toMatch(range.startOffset);
          expect(result).toMatch(range.endDate);
          expect(result).toMatch(range.endTime);
          expect(result).toMatch(range.endOffset);
          // Both instants, not one: the fold case shares a wall time but the
          // offsets differ, so a single-instant render cannot match both pins.
          const status = await page.getByTestId(STATUS_TESTID).innerText();
          expect(status).toContain(range.chosen);
          expect(status).toMatch(range.startTime);
          expect(status).toMatch(range.endTime);
          expect(await page.getByTestId(STATUS_TESTID).getAttribute("role")).toBe("status");
          expect(await page.getByTestId(STATUS_TESTID).getAttribute("aria-live")).toBe("polite");
          expect(
            await page.evaluate(() => document.activeElement?.tagName),
            "announcement must not move focus",
          ).toBe("BUTTON");
          expect(await invariant(page, range)).toEqual(initial);
          expect(await context.cookies()).toEqual(cookies);
          await assertNoEffects();
          expect(errors).toEqual([]);
        });
      }
      for (const zone of ZONE_FAILURES) {
        it(`${view}: ${zone.mode} zone gives honest guidance, never fabricated times`, async () => {
          const range = CASES[0];
          const { page, errors } = await open(view, range);
          const initial = await invariant(page, range);
          const before = await visibleText(page);
          const assertNoEffects = await guardSideEffects(page);
          await fillChosen(page, zone.value);
          await activateChosen(page);
          const guidance = async () => addedText(before, await visibleText(page));
          await expect
            .poll(guidance)
            .toMatch(
              /unavailable|unable|could not|couldn't|cannot|can't|not supported|unknown|invalid/i,
            );
          const result = await guidance();
          expect(result).toMatch(/host|shown above|calendar/i);
          expect(result).not.toMatch(/15:00|17:00|3:00\s*pm|5:00\s*pm/i);
          expect(result).not.toMatch(/GMT[+-]\d{2}:\d{2}/);
          expect(await invariant(page, range)).toEqual(initial);
          await assertNoEffects();
          expect(errors, "zone failures must not escape browser handlers").toEqual([]);
        });
      }
      for (const failure of INTL_FAILURES) {
        it(`${view}: ${failure} gives honest fallback, never a fabricated range`, async () => {
          const range = CASES[0];
          const { page, errors } = await open(view, range, failure);
          const initial = await invariant(page, range);
          const before = await visibleText(page);
          const assertNoEffects = await guardSideEffects(page);
          const input = page.getByTestId(INPUT_TESTID);
          const button = page.getByTestId(BUTTON_TESTID);
          // Missing mount is the named gap: fail fast instead of polling for
          // guidance that cannot exist. A present-but-disabled action (early
          // capability detection) still polls for immediate guidance below.
          expect(await input.count(), "missing labelled chosen-zone input").toBe(1);
          expect(await button.count(), "missing explicit Compare times action").toBe(1);
          const canActivate = await button.isEnabled();
          if (canActivate) {
            await fillChosen(page, range.chosen);
            await activateChosen(page);
          }
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
          expect(result).not.toMatch(/15:00|17:00|3:00\s*pm|5:00\s*pm/i);
          expect(await invariant(page, range)).toEqual(initial);
          await assertNoEffects();
          expect(errors, "Intl failures must not escape browser handlers").toEqual([]);
        });
      }
      it(`${view}: repeated activation recomputes only on request`, async () => {
        const range = CASES[0];
        const { page, errors } = await open(view, range);
        await fillChosen(page, "America/New_York");
        await activateChosen(page);
        await expect
          .poll(() => page.getByTestId(STATUS_TESTID).innerText())
          .toContain("America/New_York");
        const first = await page.getByTestId(STATUS_TESTID).innerText();
        expect(first).toMatch(/15:00|3:00\s*pm/i);
        await fillChosen(page, "Asia/Tokyo");
        // Retyping alone never reconverts.
        expect(await page.getByTestId(STATUS_TESTID).innerText()).toBe(first);
        await activateChosen(page);
        await expect
          .poll(() => page.getByTestId(STATUS_TESTID).innerText())
          .toContain("Asia/Tokyo");
        const second = await page.getByTestId(STATUS_TESTID).innerText();
        expect(second).not.toContain("America/New_York");
        expect(second).toMatch(/08:30|8:30\s*am|04:00|4:00\s*am/i);
        expect(errors).toEqual([]);
      });
    }
  },
);
