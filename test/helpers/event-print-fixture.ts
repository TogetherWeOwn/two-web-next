import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import type { Browser, Page } from "playwright";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../../src/events/kit-detail";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import app from "../app";

export const ORIGIN = "https://print.example.test";
export const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const EVENT_PATH = `/e/${EVENT_ID}`;
export const CANONICAL = `${ORIGIN}${EVENT_PATH}`;
export const ROSTER_NAME = "Fixture attendee";
export const RELATED_TITLE = "Other fixture game night";
export const VIEWER_ID = "100000000000000001";
const SECRET = "test-session-secret-at-least-32-bytes-long";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export type Row = typeof events.$inferSelect;
export type Viewer = "guest" | "member" | "moderator";
export type Twin = "Hono" | "Kit";

export function printRow(over: Partial<Row> = {}): Row {
  const start = new Date("2030-01-10T23:30:00Z");
  return {
    id: 7,
    icsSequence: 1n,
    eventKey: EVENT_ID,
    title: "Overnight chess & stories",
    game: "Chess",
    description: "Bring a board and a story. Everyone is welcome.",
    accessibilityNotes: "Step-free entrance; captions available.",
    startsAt: start,
    endsAt: new Date("2030-01-11T02:15:00Z"),
    timezone: "UTC",
    location: "The fixture lobby",
    organizer_name: "Fixture host",
    join_url: "https://call.example.test/open-room",
    join_instructions: "Use headphones.",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    discordEventId: null,
    syncRevision: 1,
    syncedRevision: 0,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
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
    ...over,
  };
}

export interface Fixture {
  html: string;
  status: number;
  reads: string[];
  outcome: string;
}

export async function renderPrintFixture(
  twin: Twin,
  row: Row,
  viewer: Viewer = "guest",
): Promise<Fixture> {
  const reads: string[] = [];
  const search = "?next=%2Fmembers%2Fprivate-fixture&session=fixture-context&token=fixture-bearer";
  if (twin === "Hono") {
    const columns = Object.keys(getTableColumns(events)) as (keyof Row)[];
    const db = drizzle(async (sql, params) => {
      reads.push(sql);
      if (sql.includes("set_config(") || sql.startsWith('insert into "member_data_access_logs"'))
        return { rows: [] };
      if (
        sql.includes('from "rsvps"') &&
        sql.includes('inner join "users"') &&
        !sql.includes("group by")
      )
        return { rows: [["100000000000000003", ROSTER_NAME]] };
      if (sql.includes('from "rsvps"'))
        return sql.includes("count(*)") ? { rows: [[row.id, 1]] } : { rows: [] };
      if (sql.includes('from "events"')) {
        if (sql.includes('"event_key" =') && !sql.includes('"status" =')) {
          return {
            rows: params.includes(EVENT_ID)
              ? [
                  columns.map((key) =>
                    row[key] instanceof Date ? row[key].toISOString() : row[key],
                  ),
                ]
              : [],
          };
        }
        // Neighbors/related use a six-column public projection, never SELECT *.
        return {
          rows: [
            [
              8,
              "01ARZ3NDEKTSV4RRFFQ69G5FAC",
              RELATED_TITLE,
              "2030-02-01T20:00:00Z",
              "UTC",
              "Other lobby",
            ],
          ],
        };
      }
      if (sql.includes("row_number()")) return { rows: [] };
      throw new Error(`Unexpected print fixture SQL: ${sql}`);
    });
    const session = (
      db as unknown as {
        session: { transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown> };
      }
    ).session;
    session.transaction = async (fn) => fn(db as unknown as Db);
    const sessions = createMemorySessionStore();
    let cookie = "";
    if (viewer !== "guest") {
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: VIEWER_ID,
        username: "Fixture account",
        avatar: null,
        member: true,
        moderator: viewer === "moderator",
        expiresAt: new Date(Date.now() + 3600_000),
      });
      cookie = (
        await serializeSigned("__Host-two_session", token, SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    }
    const env = {
      APP_URL: ORIGIN,
      SESSION_SECRET: SECRET,
      SESSION_STORE: sessions,
      ADMIN_DB: db,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    } as unknown as Env;
    const response = await app.request(
      `${EVENT_PATH}${search}`,
      cookie ? { headers: { cookie } } : {},
      env,
    );
    return {
      html: await response.text(),
      status: response.status,
      reads,
      outcome: String(response.status),
    };
  }
  const track =
    <T>(name: string, value: T) =>
    async () => {
      reads.push(name);
      return value;
    };
  const neighbor = {
    id: 8,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    title: RELATED_TITLE,
    startsAt: new Date("2030-02-01T20:00:00Z"),
    timezone: "UTC",
    location: "Other lobby",
  };
  const store: KitEventDetailStore = {
    dbForFn: track("db", {} as Db),
    getEventFn: track("event", { ...row, goingCount: 1, goingOccupancy: 1 }),
    neighborsFn: track("neighbors", { previous: null, next: neighbor }),
    relatedFn: track("related", [neighbor]),
    attendeesFn: track("attendees", [{ id: "100000000000000003", name: ROSTER_NAME }]),
    viewerRsvpFn: track("viewerRsvp", null),
    waitlistFn: track("waitlist", null),
    suggestionsFn: track("suggestions", []),
  };
  const outcome = await resolveKitEventDetail({
    key: EVENT_ID,
    path: EVENT_PATH,
    search,
    env: { APP_URL: ORIGIN } as Env,
    session:
      viewer === "guest"
        ? { status: "guest", session: null }
        : {
            status: "authenticated",
            session: {
              userId: VIEWER_ID,
              username: "Fixture account",
              avatar: null,
              member: true,
              moderator: viewer === "moderator",
            },
          },
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  if (outcome.kind !== "ok" && outcome.kind !== "gone") {
    return {
      html: "",
      status: outcome.kind === "redirect" ? 301 : outcome.status,
      reads,
      outcome: outcome.kind,
    };
  }
  const render = await kitRenderer();
  return {
    html: render(outcome.model, outcome.kind === "gone"),
    status: outcome.status,
    reads,
    outcome: outcome.kind,
  };
}

// Compile the real route and all imported components, retaining emitted scoped
// CSS. Root CSS comes from the real Kit build, not a test-authored theme mirror.
let kitRender: Promise<(model: unknown, gone: boolean) => string> | undefined;
function kitRenderer() {
  kitRender ??= (async () => {
    const scratch = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "event-print-ssr-"),
    );
    const webRequire = createRequire(join(ROOT, "web/package.json"));
    const { compile } = webRequire("svelte/compiler") as {
      compile: (
        source: string,
        options: Record<string, unknown>,
      ) => { js: { code: string }; css?: { code: string } };
    };
    const css: string[] = [];
    try {
      const entry = join(scratch, "entry.mjs");
      const outfile = join(scratch, "bundle.mjs");
      writeFileSync(
        entry,
        `import {render} from 'svelte/server'; import Page from ${JSON.stringify(join(ROOT, "web/src/routes/e/[key]/+page.svelte"))}; import ErrorPage from ${JSON.stringify(join(ROOT, "web/src/routes/e/[key]/+error.svelte"))}; import {page} from '$app/state'; export function renderPage(model,gone) { if(gone) {page.status=410;page.error={gone:model};return render(ErrorPage);} return render(Page,{props:{data:{model}}});}`,
      );
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "warning",
        absWorkingDir: ROOT,
        nodePaths: [join(ROOT, "web/node_modules"), join(ROOT, "node_modules")],
        alias: { "#lib": join(ROOT, "web/src/lib/") },
        plugins: [
          {
            name: "print-real-route-ssr",
            setup(plugin) {
              plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
                path: "state",
                namespace: "fixture-page",
              }));
              plugin.onLoad({ filter: /.*/, namespace: "fixture-page" }, () => ({
                contents: "export const page = { status: 200, error: null };",
                loader: "js",
              }));
              plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
                const result = compile(readFileSync(args.path, "utf8"), {
                  generate: "server",
                  dev: false,
                  filename: args.path,
                });
                if (result.css?.code) css.push(result.css.code);
                return { contents: result.js.code, loader: "js", resolveDir: dirname(args.path) };
              });
            },
          },
        ],
      });
      const { renderPage } = (await import(pathToFileURL(outfile).href)) as {
        renderPage: (model: unknown, gone: boolean) => { head: string; body: string };
      };
      const manifest = JSON.parse(
        readFileSync(join(ROOT, "web/.svelte-kit/output/client/.vite/manifest.json"), "utf8"),
      ) as Record<string, { css?: string[] }>;
      const rootCss = Object.entries(manifest).find(([key]) => /\/nodes\/0\.js$/.test(key))?.[1]
        .css;
      if (!rootCss?.length)
        throw new Error("Build Kit first: npm run build --prefix web (root CSS missing)");
      const rootStyles = rootCss
        .map((file) => readFileSync(join(ROOT, "web/.svelte-kit/output/client", file), "utf8"))
        .join("\n");
      return (model: unknown, gone: boolean) => {
        const { head, body } = renderPage(model, gone);
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<style>${rootStyles}\n${css.join("\n")}</style></head><body>${body}</body></html>`;
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  })();
  return kitRender;
}

export async function openPrintFixture(
  browser: Browser,
  fixture: Fixture,
  width = 1280,
  javaScriptEnabled = false,
) {
  const context = await browser.newContext({
    viewport: { width, height: width === 1280 ? 800 : 844 },
    javaScriptEnabled,
    locale: "en-GB",
    timezoneId: "UTC",
    serviceWorkers: "block",
  });
  await context.addInitScript(
    `window.__printInitialCalls=0; window.print=()=>{window.__printInitialCalls++;};`,
  );
  const page = await context.newPage();
  const unexpected: string[] = [];
  const requests: string[] = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    if (url.origin === ORIGIN && url.pathname === EVENT_PATH) {
      await route.fulfill({
        status: fixture.status,
        contentType: "text/html; charset=utf-8",
        body: fixture.html,
      });
      return;
    }
    const file = resolve(ROOT, "public", `.${url.pathname}`);
    if (url.origin === ORIGIN && file.startsWith(join(ROOT, "public") + "/")) {
      try {
        await route.fulfill({
          body: readFileSync(file),
          contentType: file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".svg")
                ? "image/svg+xml"
                : "application/octet-stream",
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    unexpected.push(`${url.origin}${url.pathname}`);
    await route.fulfill({ status: 204 });
  });
  await page.goto(CANONICAL);
  await page.evaluate("document.fonts.ready");
  return { page, context, requests, unexpected };
}

export async function printText(page: Page): Promise<string> {
  // Text-node spelling ignores harmless text-transform while still excluding
  // hidden ancestors, scripts and metadata. Never count serialized model JSON.
  return page.evaluate(`(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const text = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (parent && !parent.closest('script,style,noscript') && parent.checkVisibility({checkVisibilityCSS:true})) text.push(node.textContent);
    }
    for (const element of document.body.querySelectorAll('*')) {
      if (!element.checkVisibility({checkVisibilityCSS:true})) continue;
      for (const pseudo of ['::before','::after']) {
        const content = getComputedStyle(element,pseudo).content;
        if (content && !['none','normal','\"\"'].includes(content)) {
          try { text.push(JSON.parse(content)); } catch { text.push(content); }
        }
      }
    }
    return text.join(' ').replace(/\\s+/g,' ').trim();
  })()`);
}
