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
import { parse, type DefaultTreeAdapterMap } from "parse5";
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
  querySelector(selector: string): BrowserElement | null;
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
// chosenStart/chosenEnd are the exact text each labelled endpoint must carry.
const CASES = [
  {
    name: "London summer range to New York",
    chosenStart: "Wednesday, 15 July 2026 at 15:00 GMT-04:00",
    chosenEnd: "Wednesday, 15 July 2026 at 17:00 GMT-04:00",
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
    chosenStart: "Thursday, 16 July 2026 at 08:30 GMT+09:00",
    chosenEnd: "Thursday, 16 July 2026 at 10:30 GMT+09:00",
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
    chosenStart: "Sunday, 1 November 2026 at 01:30 GMT-04:00",
    chosenEnd: "Sunday, 1 November 2026 at 01:30 GMT-05:00",
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
    chosenStart: "Sunday, 8 March 2026 at 01:30 GMT-05:00",
    chosenEnd: "Sunday, 8 March 2026 at 03:30 GMT-04:00",
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
    chosenStart: "Thursday, 16 July 2026 at 00:45 GMT+05:45",
    chosenEnd: "Thursday, 16 July 2026 at 02:45 GMT+05:45",
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
    chosenStart: "Wednesday, 15 July 2026 at 20:00 GMT+01:00",
    chosenEnd: "Wednesday, 15 July 2026 at 22:00 GMT+01:00",
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
    chosenStart: "Wednesday, 15 July 2026 at 22:00 GMT-04:00",
    chosenEnd: "Thursday, 16 July 2026 at 02:00 GMT-04:00",
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

type ParsedNode = DefaultTreeAdapterMap["node"];
type ParsedElement = DefaultTreeAdapterMap["element"];
function descendants(node: ParsedNode): ParsedNode[] {
  // Template contents are a separate DocumentFragment, not document descendants.
  return [node, ...("childNodes" in node ? node.childNodes.flatMap(descendants) : [])];
}
function isElement(node: ParsedNode): node is ParsedElement {
  return "tagName" in node;
}
function elements(node: ParsedNode): ParsedElement[] {
  return descendants(node).slice(1).filter(isElement);
}
function attribute(node: ParsedElement, name: string): string | undefined {
  return node.attrs.find((attr) => attr.name === name && !attr.namespace)?.value;
}
function text(node: ParsedNode): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}
function closestElement(node: ParsedElement, tag: string): ParsedElement | undefined {
  let current: ParsedNode | null = node;
  while (current) {
    if (isElement(current) && current.tagName === tag) return current;
    current = "parentNode" in current ? current.parentNode : null;
  }
  return undefined;
}

function assertStructure(html: string, range: RangeCase) {
  const nodes = elements(parse(html, { sourceCodeLocationInfo: true }));
  // Census the complete document exactly as the binder does, regardless of tag or position.
  const mounts = nodes.filter(
    (node) => attribute(node, "data-event-chosen-timezone") !== undefined,
  );
  expect(mounts.length, "exactly one chosen-range mount per detail page").toBe(1);
  const mount = mounts[0]!;
  expect(mount.tagName).toBe("dd");
  const row = mount.parentNode;
  expect(row?.nodeName).toBe("div");
  if (!row || !isElement(row)) throw new Error("Missing chosen metadata row");
  const list = closestElement(mount, "dl");
  expect(list, "chosen mount must have the binder's closest dl").toBeDefined();
  if (!list) throw new Error("Missing chosen metadata list");
  expect(row.parentNode === list, "chosen row belongs directly to Event details").toBe(true);
  expect(attribute(list, "aria-label")).toBe("Event details");
  const lists = nodes.filter(
    (node) => node.tagName === "dl" && attribute(node, "aria-label") === "Event details",
  );
  expect(lists.length, "one Event details list in the whole document").toBe(1);
  expect(lists[0] === list).toBe(true);
  const siblings = row.childNodes.filter(isElement);
  expect(siblings.map((node) => node.tagName)).toEqual(["dt", "dd"]);
  expect(text(siblings[0]!).trim()).toBe("Compare in another timezone");
  expect(siblings[1] === mount).toBe(true);
  expect(attribute(row, "hidden"), "the complete chosen row is initially hidden").toBeDefined();

  const controls = [INPUT_TESTID, EXAMPLES_TESTID, BUTTON_TESTID, STATUS_TESTID].map((testid) => {
    const matches = nodes.filter((node) => attribute(node, "data-testid") === testid);
    expect(matches.length, `${testid} occurs exactly once in the whole document`).toBe(1);
    const control = matches[0]!;
    expect(control.parentNode === mount, `${testid} belongs directly to the chosen mount`).toBe(
      true,
    );
    return control;
  });
  const [input, examples, button, status] = controls as [
    ParsedElement,
    ParsedElement,
    ParsedElement,
    ParsedElement,
  ];
  const local = elements(mount);
  const labels = local.filter((node) => node.tagName === "label");
  expect(labels.length, "one actual chosen-input label").toBe(1);
  const label = labels[0]!;
  const ordered = [label, input, examples, button, status];
  const actual = mount.childNodes.filter(isElement);
  expect(actual.length).toBe(ordered.length);
  expect(actual.every((node, index) => node === ordered[index]), "chosen controls retain order").toBe(
    true,
  );
  expect(local.filter((node) => node.tagName === "input").length).toBe(1);
  expect(local.filter((node) => node.tagName === "button").length).toBe(1);
  expect(local.filter((node) => attribute(node, "role") === "status").length).toBe(1);

  expect(input.tagName).toBe("input");
  expect(attribute(input, "hidden")).toBeDefined();
  const max = attribute(input, "maxlength");
  expect(max, "input must carry a bounded maxlength").toBeDefined();
  expect(max).toMatch(/^\d+$/);
  expect(Number(max)).toBeGreaterThanOrEqual(32);
  expect(Number(max)).toBeLessThanOrEqual(128);
  expect(Number(max)).toBeLessThanOrEqual(100 + 28);
  // Native text entry, not a picker widget or remote combobox.
  expect(attribute(input, "role")).not.toBe("combobox");
  expect([undefined, "textbox"]).toContain(attribute(input, "role"));
  expect(["text", "search"]).toContain((attribute(input, "type") ?? "text").toLowerCase());
  expect(attribute(input, "disabled")).toBeUndefined();
  expect(attribute(input, "readonly")).toBeUndefined();
  const id = attribute(input, "id");
  expect(id, "chosen input must have a unique id").toBeDefined();
  expect(id?.trim().length).toBeGreaterThan(0);
  const ids = nodes.filter((node) => attribute(node, "id") === id);
  expect(ids.length, "chosen input id is globally unique").toBe(1);
  expect(ids[0] === input).toBe(true);
  expect(attribute(label, "for"), "chosen label binds to the actual input").toBe(id);
  const boundLabels = nodes.filter(
    (node) => node.tagName === "label" && attribute(node, "for") === id,
  );
  expect(boundLabels.length, "chosen input has one globally unique label binding").toBe(1);
  expect(boundLabels[0] === label).toBe(true);
  expect(text(label), "chosen input must have a visible label").toMatch(/timezone/i);

  expect(examples.tagName).toBe("p");
  const examplesBody = text(examples);
  expect(examplesBody.length, "examples stay compact").toBeLessThan(300);
  expect(examplesBody).toMatch(/Europe\/London|America\/New_York|Asia\/Tokyo/);
  expect(button.tagName).toBe("button");
  expect(attribute(button, "type")).toBe("button");
  expect(attribute(button, "hidden")).toBeDefined();
  expect(attribute(button, "disabled")).toBeUndefined();
  expect(text(button).trim()).toMatch(COMPARE);
  expect(status.tagName).toBe("p");
  expect(attribute(status, "role")).toBe("status");
  expect(attribute(status, "aria-live")).toBe("polite");
  expect(text(status).trim(), "fresh render never pre-fills a comparison").toBe("");
  expect(
    status.childNodes.every((node) => node.nodeName === "#text" && text(node).trim() === ""),
    "fresh status has no hidden or non-text prefill",
  ).toBe(true);

  const deviceMounts = nodes.filter(
    (node) => attribute(node, "data-event-device-timezone") !== undefined,
  );
  expect(deviceMounts.length, "Starts and Ends device mounts remain globally unique").toBe(2);
  const times: ParsedElement[] = [];
  const rows: ParsedElement[] = [];
  const deviceButtons: ParsedElement[] = [];
  const deviceStatuses: ParsedElement[] = [];
  for (const [index, contract] of [
    { label: "Starts", instant: range.start, hostText: range.hostStart },
    { label: "Ends", instant: range.end, hostText: range.hostEnd },
  ].entries()) {
    const terms = elements(list).filter(
      (node) => node.tagName === "dt" && text(node).trim() === contract.label,
    );
    expect(terms.length, `one ${contract.label} row in the chosen mount's list`).toBe(1);
    const hostRow = terms[0]!.parentNode;
    expect(hostRow?.nodeName).toBe("div");
    if (!hostRow || !isElement(hostRow)) throw new Error("Missing host metadata row");
    expect(hostRow.parentNode === list).toBe(true);
    const parts = hostRow.childNodes.filter(isElement);
    expect(parts.map((node) => node.tagName)).toEqual(["dt", "dd", "dd"]);
    expect(parts[0] === terms[0]).toBe(true);
    const hostTimes = elements(hostRow).filter((node) => node.tagName === "time");
    expect(hostTimes.length, `one ${contract.label} host time in its own row`).toBe(1);
    const time = hostTimes[0]!;
    expect(time.parentNode === parts[1]).toBe(true);
    expect(attribute(time, "datetime")).toBe(contract.instant);
    expect(text(time)).toBe(contract.hostText);
    const device = deviceMounts[index]!;
    expect(device === parts[2], `${contract.label} device mount owns its host row`).toBe(true);
    const deviceParts = device.childNodes.filter(isElement);
    expect(deviceParts.map((node) => node.tagName)).toEqual(["button", "p"]);
    const deviceButton = deviceParts[0]!;
    const deviceStatus = deviceParts[1]!;
    for (const [testid, control] of [
      [`event-device-timezone-${contract.label.toLowerCase()}-button`, deviceButton],
      [`event-device-timezone-${contract.label.toLowerCase()}-status`, deviceStatus],
    ] as const) {
      const matches = nodes.filter((node) => attribute(node, "data-testid") === testid);
      expect(matches.length, `${testid} occurs exactly once in the whole document`).toBe(1);
      expect(matches[0] === control, `${testid} belongs to its own host row`).toBe(true);
    }
    expect(attribute(deviceButton, "type")).toBe("button");
    expect(attribute(deviceButton, "hidden")).toBeDefined();
    expect(text(deviceButton).trim()).toBe("Show in my device timezone");
    expect(attribute(deviceStatus, "role")).toBe("status");
    expect(attribute(deviceStatus, "aria-live")).toBe("polite");
    expect(
      deviceStatus.childNodes.every((node) => node.nodeName === "#text" && text(node).trim() === ""),
    ).toBe(true);
    expect(nodes.indexOf(time)).toBeLessThan(nodes.indexOf(deviceButton));
    expect(nodes.indexOf(deviceButton)).toBeLessThan(nodes.indexOf(deviceStatus));
    times.push(time);
    rows.push(hostRow);
    deviceButtons.push(deviceButton);
    deviceStatuses.push(deviceStatus);
  }
  // These are exactly closest('dl').querySelectorAll('time[datetime]') in binder order.
  const binderTimes = elements(list).filter(
    (node) => node.tagName === "time" && attribute(node, "datetime") !== undefined,
  );
  expect(binderTimes.length, "only the independent Starts and Ends host instants").toBe(2);
  expect(binderTimes[0] === times[0], "binder's first instant is Starts").toBe(true);
  expect(binderTimes[1] === times[1], "binder's second instant is Ends").toBe(true);
  expect(nodes.indexOf(deviceStatuses[0]!)).toBeLessThan(nodes.indexOf(times[1]!));
  expect(nodes.indexOf(deviceStatuses[1]!)).toBeLessThan(nodes.indexOf(mount));
  expect(nodes.indexOf(input)).toBeLessThan(nodes.indexOf(button));
  expect(nodes.indexOf(button)).toBeLessThan(nodes.indexOf(status));
  return {
    nodes,
    mount,
    row,
    list,
    label,
    input,
    examples,
    button,
    status,
    times,
    rows,
    deviceMounts,
    deviceButtons,
    deviceStatuses,
  };
}

type HtmlEdit = { startOffset: number; endOffset: number; replacement: string };
function elementEdit(node: ParsedElement, replacement: string): HtmlEdit {
  const location = node.sourceCodeLocation;
  if (!location) throw new Error("Control requires an element source location");
  return { startOffset: location.startOffset, endOffset: location.endOffset, replacement };
}
function attributeEdit(node: ParsedElement, name: string, replacement = ""): HtmlEdit {
  const location = node.sourceCodeLocation?.attrs?.[name];
  if (!location) throw new Error(`Control requires attribute ${name}`);
  return { startOffset: location.startOffset, endOffset: location.endOffset, replacement };
}
function sourceHtml(html: string, node: ParsedElement): string {
  const location = elementEdit(node, "");
  return html.slice(location.startOffset, location.endOffset);
}
function editedHtml(html: string, edits: HtmlEdit[]): string {
  for (const edit of [...edits].sort((a, b) => b.startOffset - a.startOffset))
    html = html.slice(0, edit.startOffset) + edit.replacement + html.slice(edit.endOffset);
  return html;
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
        const structure = assertStructure(html, range);
        const { nodes, mount, row, list, label, input, examples, button, status, times, rows } =
          structure;
        // Keep the entire fixture and Kit serialization; edit original source locations only.
        const body = nodes.find((node) => node.tagName === "body");
        const bodyStart = body?.sourceCodeLocation?.startTag?.endOffset;
        const bodyEnd = html.lastIndexOf("</body>");
        expect(bodyStart, "controls retain the complete document wrapper").toBeDefined();
        expect(bodyEnd).toBeGreaterThan(bodyStart!);
        const insert = (offset: number, replacement: string): HtmlEdit => ({
          startOffset: offset,
          endOffset: offset,
          replacement,
        });
        const decoy = sourceHtml(html, mount);
        const serialized = JSON.stringify({ metadata: decoy }).replace(/</g, "\\u003c");
        const escaped = decoy.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const inert = `<script type="application/json">${serialized}</script><script>const chosenCopy=${serialized};</script><!--${decoy}--><p>${escaped}</p><template>${decoy}</template><span data-event-chosen-timezone-copy></span>`;
        const positive = editedHtml(html, [
          insert(bodyStart!, '<label for="unrelated-zone">Unrelated field</label>'),
          insert(bodyEnd, inert),
        ]);
        expect(positive).toContain(serialized);
        assertStructure(positive, range);
        for (const [type, max] of [
          ["search", 32],
          [undefined, 128],
        ] as const) {
          assertStructure(
            editedHtml(html, [
              attributeEdit(input, "type", type ? `type="${type}"` : ""),
              attributeEdit(input, "maxlength", `maxlength="${max}"`),
            ]),
            range,
          );
        }

        const rejects = (name: string, edits: HtmlEdit[]) => {
          expect(
            () => assertStructure(editedHtml(html, edits), range),
            `${view}: ${range.name}: ${name}`,
          ).toThrow();
        };
        for (const offset of [bodyStart!, bodyEnd]) {
          rejects(`real non-dd mount outside the metadata at ${offset}`, [
            insert(offset, "<span data-event-chosen-timezone></span>"),
          ]);
        }
        rejects("missing mount attribute", [attributeEdit(mount, "data-event-chosen-timezone")]);
        rejects("removed mount", [elementEdit(mount, "")]);
        rejects("duplicated real mount", [elementEdit(mount, decoy.repeat(2))]);
        const rowEnd = row.sourceCodeLocation?.endTag?.startOffset;
        expect(rowEnd).toBeDefined();
        for (const control of [input, examples, button, status]) {
          const testid = attribute(control, "data-testid")!;
          const original = sourceHtml(html, control);
          rejects(`missing ${testid}`, [elementEdit(control, "")]);
          rejects(`missing testid ${testid}`, [attributeEdit(control, "data-testid")]);
          rejects(`duplicate inside mount ${testid}`, [elementEdit(control, original.repeat(2))]);
          rejects(`duplicate outside row ${testid}`, [insert(bodyEnd, original)]);
          rejects(`wrong native element ${testid}`, [
            elementEdit(control, `<span data-testid="${testid}"></span>`),
          ]);
          rejects(`relocated outside mount but inside row ${testid}`, [
            elementEdit(control, ""),
            insert(rowEnd!, original),
          ]);
          rejects(`relocated outside row ${testid}`, [
            elementEdit(control, ""),
            insert(bodyEnd, original),
          ]);
        }
        const inputId = attribute(input, "id")!;
        rejects("missing chosen label", [elementEdit(label, "")]);
        rejects("duplicate local label", [elementEdit(label, sourceHtml(html, label).repeat(2))]);
        rejects("duplicate external label binding", [insert(bodyEnd, sourceHtml(html, label))]);
        rejects("relocated label", [
          elementEdit(label, ""),
          insert(bodyEnd, sourceHtml(html, label)),
        ]);
        rejects("missing label binding", [attributeEdit(label, "for")]);
        rejects("wrong label binding", [attributeEdit(label, "for", 'for="wrong-input"')]);
        rejects("missing input id", [attributeEdit(input, "id")]);
        rejects("empty input id", [attributeEdit(input, "id", 'id=""')]);
        rejects("duplicate external input id", [insert(bodyEnd, `<input id="${inputId}">`)]);
        rejects("wrong label copy", [
          elementEdit(label, `<label for="${inputId}">Choose region</label>`),
        ]);
        rejects("missing maxlength", [attributeEdit(input, "maxlength")]);
        for (const max of ["", "31", "129", "64x"]) {
          rejects(`invalid maxlength ${JSON.stringify(max)}`, [
            attributeEdit(input, "maxlength", `maxlength="${max}"`),
          ]);
        }
        rejects("non-text native input", [attributeEdit(input, "type", 'type="radio"')]);
        for (const extra of ['role="combobox"', "disabled", "readonly"]) {
          rejects(`malformed input ${extra}`, [attributeEdit(input, "hidden", `hidden ${extra}`)]);
        }
        for (const control of [row, input, button]) {
          rejects(`missing initial hiding on ${control.tagName}`, [
            attributeEdit(control, "hidden"),
          ]);
        }
        rejects("unbounded examples copy", [
          elementEdit(examples, `<p data-testid="${EXAMPLES_TESTID}">${"x".repeat(300)}</p>`),
        ]);
        rejects("missing IANA examples", [
          elementEdit(examples, `<p data-testid="${EXAMPLES_TESTID}">Choose a region</p>`),
        ]);
        rejects("missing Compare button type", [attributeEdit(button, "type")]);
        rejects("submitting Compare button", [attributeEdit(button, "type", 'type="submit"')]);
        rejects("wrong Compare copy", [
          elementEdit(button, sourceHtml(html, button).replace("Compare times", "Show host time")),
        ]);
        for (const name of ["role", "aria-live"]) {
          rejects(`missing status ${name}`, [attributeEdit(status, name)]);
        }
        rejects("wrong status role", [attributeEdit(status, "role", 'role="alert"')]);
        rejects("wrong live mode", [attributeEdit(status, "aria-live", 'aria-live="off"')]);
        for (const prefill of ["Already converted", "<span></span>"]) {
          rejects(`prefilled status ${prefill}`, [
            elementEdit(status, sourceHtml(html, status).replace("</p>", `${prefill}</p>`)),
          ]);
        }
        rejects("wrong Event details list label", [
          attributeEdit(list, "aria-label", 'aria-label="Other details"'),
        ]);
        rejects("chosen row belongs to another closest dl", [
          elementEdit(row, ""),
          insert(bodyEnd, `<dl aria-label="Other details">${sourceHtml(html, row)}</dl>`),
        ]);
        const listStart = list.sourceCodeLocation?.startTag?.endOffset;
        expect(listStart).toBeDefined();
        rejects("decoy instant precedes the binder's host times", [
          insert(listStart!, '<time datetime="2000-01-01T00:00:00.000Z">Decoy</time>'),
        ]);
        for (const [index, time] of times.entries()) {
          rejects(`removed host instant ${index}`, [elementEdit(time, "")]);
          rejects(`missing machine instant ${index}`, [attributeEdit(time, "datetime")]);
          rejects(`wrong machine instant ${index}`, [
            attributeEdit(time, "datetime", 'datetime="2000-01-01T00:00:00.000Z"'),
          ]);
          rejects(`wrong host text ${index}`, [
            elementEdit(time, `<time datetime="${attribute(time, "datetime")}">Wrong host</time>`),
          ]);
          rejects(`removed host row ${index}`, [elementEdit(rows[index]!, "")]);
          for (const control of [
            structure.deviceButtons[index]!,
            structure.deviceStatuses[index]!,
          ]) {
            const testid = attribute(control, "data-testid")!;
            rejects(`missing device ${testid}`, [elementEdit(control, "")]);
            rejects(`duplicate external device ${testid}`, [
              insert(bodyEnd, sourceHtml(html, control)),
            ]);
          }
        }
        rejects("extra real device mount outside the list", [
          insert(bodyEnd, "<span data-event-device-timezone></span>"),
        ]);
        for (const [name, pair] of [
          ["host instants", times],
          ["host rows", rows],
          ["device mounts", structure.deviceMounts],
          ["device buttons", structure.deviceButtons],
          ["device statuses", structure.deviceStatuses],
          ["chosen input and action", [input, button]],
          ["examples and status", [examples, status]],
        ] as const) {
          rejects(`cross-wired or reordered ${name}`, [
            elementEdit(pair[0]!, sourceHtml(html, pair[1]!)),
            elementEdit(pair[1]!, sourceHtml(html, pair[0]!)),
          ]);
        }
        rejects("duplicated Starts in place of Ends", [
          elementEdit(times[1]!, sourceHtml(html, times[0]!)),
        ]);
        rejects("swapped machine values without swapping text", [
          attributeEdit(times[0]!, "datetime", `datetime="${range.end}"`),
          attributeEdit(times[1]!, "datetime", `datetime="${range.start}"`),
        ]);
        rejects("chosen row before Ends", [
          elementEdit(row, ""),
          insert(elementEdit(rows[1]!, "").startOffset, sourceHtml(html, row)),
        ]);
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
    function splitChosenStatus(status: string) {
      const match = /^In ([^:]+): starts (.+); ends (.+)\.$/.exec(status.trim());
      expect(
        match,
        `status must read "In <zone>: starts <start>; ends <end>.", got: ${status}`,
      ).not.toBe(null);
      return { zone: match![1], start: match![2], end: match![3] };
    }
    // The whole chosen-zone row is JS-only: with scripts off, nothing of it is visible.
    async function chosenRowVisibility(page: Page) {
      return page.evaluate(() => {
        const mount = document.querySelector("[data-event-chosen-timezone]");
        const row = mount?.closest("div") ?? null;
        const parts: Record<string, BrowserElement | null> = {
          row,
          label: document.querySelector('label[for="chosen-timezone-input"]'),
          heading: row?.querySelector("dt") ?? null,
          input: document.querySelector('[data-testid="event-chosen-timezone-input"]'),
          examples: document.querySelector('[data-testid="event-chosen-timezone-examples"]'),
          button: document.querySelector('[data-testid="event-chosen-timezone-button"]'),
          status: document.querySelector('[data-testid="event-chosen-timezone-status"]'),
        };
        const found: Record<string, boolean> = {};
        const visible: Record<string, boolean> = {};
        for (const [name, node] of Object.entries(parts)) {
          found[name] = node !== null;
          visible[name] = node?.checkVisibility({ checkVisibilityCSS: true }) ?? false;
        }
        return { found, visible, rowText: row?.textContent ?? "" };
      });
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
      it(`${view}: real no-JS browser hides the whole chosen-zone row, label and examples`, async () => {
        for (const range of [CASES[0], CASES[2]]) {
          const { page, errors } = await open(view, range, undefined, false);
          const row = await chosenRowVisibility(page);
          // Every part is served (so the hiding assertion is not vacuous)...
          expect(row.found).toEqual({
            row: true,
            label: true,
            heading: true,
            input: true,
            examples: true,
            button: true,
            status: true,
          });
          expect(row.rowText).toContain("Timezone (IANA identifier)");
          // ...and none of it is visible without JS: no orphaned label or examples.
          expect(row.visible).toEqual({
            row: false,
            label: false,
            heading: false,
            input: false,
            examples: false,
            button: false,
            status: false,
          });
          const body = await page.locator("body").innerText();
          expect(body).not.toContain("Compare in another timezone");
          expect(body).not.toContain("Timezone (IANA identifier)");
          expect(body).not.toContain("e.g. Europe/London");
          expect(body).not.toContain("Compare times");
          // Original controls stay true: host schedule and calendar links remain visible.
          expect(await page.locator(`time[datetime="${range.start}"]`).first().isVisible()).toBe(
            true,
          );
          expect(errors).toEqual([]);
        }
      });
      it(`${view}: with JS the whole chosen-zone row is revealed together`, async () => {
        const { page, errors } = await open(view, CASES[0]);
        await expect
          .poll(async () => (await chosenRowVisibility(page)).visible)
          .toEqual({
            row: true,
            label: true,
            heading: true,
            input: true,
            examples: true,
            button: true,
            status: true,
          });
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
          // Endpoint attribution: the text after each label carries that instant's
          // own date, wall time and offset. Swapped labels or instants fail here.
          const endpoints = splitChosenStatus(status);
          expect(endpoints.zone).toBe(range.chosen);
          expect(endpoints.start, "text after 'starts' is the start instant").toBe(
            range.chosenStart,
          );
          expect(endpoints.end, "text after 'ends' is the end instant").toBe(range.chosenEnd);
          expect(endpoints.start).toMatch(range.startDate);
          expect(endpoints.start).toMatch(range.startTime);
          expect(endpoints.start).toMatch(range.startOffset);
          expect(endpoints.end).toMatch(range.endDate);
          expect(endpoints.end).toMatch(range.endTime);
          expect(endpoints.end).toMatch(range.endOffset);
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
      for (const [range, padded] of [
        [CASES[0], " America/New_York "],
        [CASES[2], "\tAmerica/New_York  "],
        [CASES[1], "  Asia/Tokyo"],
      ] as const) {
        it(`${view}: ignores surrounding whitespace in ${JSON.stringify(padded)} (${range.name})`, async () => {
          const { page, context, errors } = await open(view, range);
          const initial = await invariant(page, range);
          const cookies = await context.cookies();
          const assertNoEffects = await guardSideEffects(page);
          await fillChosen(page, padded);
          expect(
            await page.getByTestId(INPUT_TESTID).inputValue(),
            "padding reaches the handler",
          ).toBe(padded);
          // Typing alone never converts, and the padded entry is never rewritten or submitted.
          expect(await page.getByTestId(STATUS_TESTID).innerText()).toBe("");
          await activateChosen(page);
          await expect
            .poll(() => page.getByTestId(STATUS_TESTID).innerText())
            .toContain(range.chosen);
          const status = await page.getByTestId(STATUS_TESTID).innerText();
          expect(status).toBe(
            `In ${range.chosen}: starts ${range.chosenStart}; ends ${range.chosenEnd}.`,
          );
          const endpoints = splitChosenStatus(status);
          expect(endpoints.start).toBe(range.chosenStart);
          expect(endpoints.end).toBe(range.chosenEnd);
          // No automatic conversion: the host values and the entered text are unchanged.
          expect(await page.getByTestId(INPUT_TESTID).inputValue()).toBe(padded);
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
