// Acceptance-owned fixtures: real route/read/render code, synthetic public rows.
// The proxy is an HTTP/UI harness, not evidence of PostgreSQL predicate semantics;
// past-archive-search-sql-acceptance.test.ts proves those against real SQL.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { discordEventsSource } from "../../src/events/discord-transients";
import { listArchiveGames, listPast, type PublicEvent } from "../../src/events/reads";
import { dispatchEventsRequest, loadEventsPage } from "../../src/kit-events";
import { renderEventsHtml } from "../../src/kit-events-html";
import {
  dispatchPastArchiveRequest,
  loadPastArchivePage,
  toPublicPastArchiveRow,
} from "../../src/kit-past-events";
import { kitEventsJourneyFor, kitEventsSessionFor } from "../../src/kit-session";
import app from "../app";

export const ARCHIVE_ORIGIN = "https://archive.example.test";
export const ARCHIVE_NOW = new Date("2030-06-15T12:00:00Z");
export const ARCHIVE_QUERY = "Raid  night";
export type ArchiveTwin = "Hono" | "Kit";
export const archiveTwins: ArchiveTwin[] = ["Hono", "Kit"];

export function archiveRow(id: number, overrides: Partial<PublicEvent> = {}): PublicEvent {
  const date = new Date("2020-01-01T20:00:00Z");
  return {
    id,
    icsSequence: 1n,
    syncRevision: 1,
    syncedRevision: 0,
    eventKey: `archive-match-${id}`,
    title: `${ARCHIVE_QUERY} ${id}`,
    game: null,
    description: null,
    startsAt: date,
    endsAt: new Date("2020-01-01T22:00:00Z"),
    timezone: "UTC",
    location: null,
    capacity: null,
    status: "past",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: date,
    updatedAt: date,
    goingCount: 0,
    goingOccupancy: 0,
    ...overrides,
  };
}

// All matching starts tie, including across the 20/5 boundary. Explicit ids
// interleave nonmatches, so filtering after LIMIT/OFFSET cannot produce 20/5.
export function archiveRows(): PublicEvent[] {
  return Array.from({ length: 25 }, (_, i) => {
    const n = i + 1;
    return [
      archiveRow(n * 2, {
        eventKey: `archive-match-${n}`,
        title: n === 3 ? `Other title ${n}` : `${ARCHIVE_QUERY} ${n}`,
        description: n === 3 ? `About ${ARCHIVE_QUERY}` : null,
        status: n % 2 === 0 ? "published" : "past",
      }),
      archiveRow(n * 2 + 1, {
        eventKey: `archive-other-${n}`,
        title: `Chess ${n}`,
        game: n === 2 ? ARCHIVE_QUERY : null,
      }),
    ];
  })
    .flat()
    .sort((a, b) => b.id - a.id);
}

export const firstMatchKeys = Array.from({ length: 20 }, (_, i) => `archive-match-${25 - i}`);
export const lastMatchKeys = [
  "archive-match-5",
  "archive-match-4",
  "archive-match-3",
  "archive-match-2",
  "archive-match-1",
];
export const eventKeys = (html: string): string[] =>
  [...html.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]!);

// Walk text tokens in our synthetic inline markup, respecting quoted attributes
// and Svelte comments. This is assertion text, never sanitized or rendered HTML.
function linkLabel(fragment: string): string {
  const text: string[] = [];
  let cursor = 0;
  while (cursor < fragment.length) {
    const start = fragment.indexOf("<", cursor);
    if (start === -1) {
      text.push(fragment.slice(cursor));
      break;
    }
    text.push(fragment.slice(cursor, start));
    if (fragment.startsWith("<!--", start)) {
      const end = fragment.indexOf("-->", start + 4);
      if (end === -1) throw new Error("Incomplete archive link label fixture");
      cursor = end + 3;
      continue;
    }
    let quote = "";
    let end = start + 1;
    for (; end < fragment.length; end++) {
      const char = fragment[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end === fragment.length) throw new Error("Incomplete archive link label fixture");
    cursor = end + 1;
  }
  return text.join("").trim();
}

export function linksIn(html: string): { url: URL; label: string; pager: boolean }[] {
  return [...html.matchAll(/<a\b([^>]*?)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    url: new URL(m[2]!.replaceAll("&amp;", "&"), ARCHIVE_ORIGIN),
    label: linkLabel(m[4]!),
    pager: /\bdata-archive-page\b/.test(m[1]! + m[3]!),
  }));
}

export function archiveEnv(db: Db): Env {
  return {
    APP_URL: ARCHIVE_ORIGIN,
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    ADMIN_DB: db,
    DISCORD_INVITE_URL: "https://discord.gg/example",
    DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
  } as unknown as Env;
}

export function archiveReadFixture() {
  const statements: { sql: string; params: unknown[] }[] = [];
  let rows = archiveRows();
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes('from "rsvps"') || !sql.startsWith("select ")) return { rows: [] };
    // Calendar upcoming/Discord-id lookups are empty in this past-only fixture.
    if (!params.includes("past") && !sql.includes('"events"."ends_at" < '))
      return { rows: sql.startsWith("select count(*)") ? [[0]] : [] };
    // Archive game suggestions: one column of distinct trimmed games, like the
    // DISTINCT ON read (case-insensitive, first-seen wins), honoring its limit.
    if (/^select distinct/i.test(sql)) {
      const seen = new Map<string, string>();
      for (const row of rows) {
        if (row.game === null) continue;
        const trimmed = row.game.trim();
        if (trimmed === "") continue;
        const folded = trimmed.toLowerCase();
        if (!seen.has(folded)) seen.set(folded, trimmed);
      }
      const limit = Number(params.at(-1));
      const games = [...seen.values()];
      return {
        rows: (Number.isSafeInteger(limit) ? games.slice(0, limit) : games).map((game) => [game]),
      };
    }
    const pattern = sql.toLowerCase().includes("ilike")
      ? params.find(
          (p): p is string => typeof p === "string" && p.startsWith("%") && p.endsWith("%"),
        )
      : undefined;
    const literal = pattern
      ?.slice(1, -1)
      .replace(/\\([\\%_])/g, "$1")
      .toLowerCase();
    const selected =
      literal === undefined
        ? rows
        : rows.filter((row) =>
            [row.title, row.description].some((value) => value?.toLowerCase().includes(literal)),
          );
    if (sql.startsWith("select count(*)")) return { rows: [[selected.length]] };
    const offset = sql.includes(" offset ") ? Number(params.at(-1)) : 0;
    const limit = Number(params.at(sql.includes(" offset ") ? -2 : -1));
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
    return {
      rows: selected
        .slice(offset, offset + limit)
        .map((row) =>
          columns.map((key) =>
            row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
          ),
        ),
    };
  }) as unknown as Db;
  return {
    db,
    env: archiveEnv(db),
    statements,
    replaceRows: (next: PublicEvent[]) => {
      rows = next;
    },
  };
}

const kitDependencies = {
  dbFor: async (c: { env: Env }) => (c.env as Env & { ADMIN_DB?: Db }).ADMIN_DB ?? null,
  listArchiveGames,
  listPast,
  loadPastArchivePage,
  toPublicPastArchiveRow,
  loadEventsPage,
  renderEventsHtml,
  kitEventsSessionFor,
  kitEventsJourneyFor,
  discordEventsSource,
};
type KitBinding = {
  request: (request: Request, env: Env, deps: typeof kitDependencies) => Promise<Response>;
};

// Compile the real Kit loader AND Svelte page. Only the Workers env binding and
// imported dependency identity are adapted, not URL parsing, loading or markup.
export async function compileArchiveKit() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const requireWeb = createRequire(join(root, "web/package.json"));
  const { compile } = requireWeb("svelte/compiler") as {
    compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
  };
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "archive-acceptance-"),
  );
  const outfile = join(scratch, "kit.mjs");
  const dependencyExports = new Map([
    [join(root, "src/admin/db.ts"), ["dbFor"]],
    [join(root, "src/events/reads.ts"), ["listArchiveGames", "listPast"]],
    [join(root, "src/kit-past-events.ts"), ["loadPastArchivePage", "toPublicPastArchiveRow"]],
    [join(root, "src/kit-events.ts"), ["loadEventsPage"]],
    [join(root, "src/kit-events-html.ts"), ["renderEventsHtml"]],
    [join(root, "src/kit-session.ts"), ["kitEventsSessionFor", "kitEventsJourneyFor"]],
    [join(root, "src/events/discord-transients.ts"), ["discordEventsSource"]],
  ]);
  const result = await build({
    metafile: true,
    stdin: {
      contents: `
        import { render } from "svelte/server";
        import Page from ${JSON.stringify(join(root, "web/src/routes/events/past/+page.svelte"))};
        import { load } from ${JSON.stringify(join(root, "web/src/routes/events/past/+page.server.ts"))};
        import { GET } from ${JSON.stringify(join(root, "web/src/routes/events/+server.ts"))};
        import { bind } from "acceptance:bindings";
        export async function request(request, env, deps) {
          bind(env, deps);
          const headers = new Headers({"content-type": "text/html; charset=utf-8"});
          try {
            if (new URL(request.url).pathname === "/events") {
              return await GET({request, url: new URL(request.url), cookies: {delete() {
                throw new Error("Anonymous calendar fixture unexpectedly consumed a cookie");
              }}, setHeaders: next => {
                for (const [key, value] of Object.entries(next)) headers.set(key, value);
              }});
            }
            const data = await load({url: new URL(request.url), request, setHeaders: next => {
              for (const [key, value] of Object.entries(next)) {
                if (headers.has(key)) throw new Error("duplicate setHeaders: " + key);
                headers.set(key, value);
              }
            }});
            const {head, body} = render(Page, {props: {data}});
            return new Response("<!doctype html><html><head>"+head+"</head><body>"+body+"</body></html>", {headers});
          } catch (error) {
            if (!error.status) throw error;
            return new Response(error.body?.message ?? error.message, {status:error.status, headers});
          }
        }
      `,
      resolveDir: root,
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "archive-acceptance-bindings",
        setup(plugin) {
          plugin.onResolve({ filter: /^acceptance:bindings$/ }, () => ({
            path: "bindings",
            namespace: "acceptance",
          }));
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "env",
            namespace: "acceptance",
          }));
          plugin.onLoad({ filter: /\.ts$/ }, (args) => {
            // Match resolved files rather than import spelling, so aliases and
            // explicit extensions keep the same cache/read dependency identity.
            const names = dependencyExports.get(args.path);
            if (!names) return;
            return {
              contents:
                'import {deps} from "acceptance:bindings";' +
                names
                  .map((name) => `export const ${name}=(...args)=>deps.${name}(...args);`)
                  .join("\n"),
              loader: "js",
            };
          });
          plugin.onLoad({ filter: /.*/, namespace: "acceptance" }, (args) => ({
            contents:
              args.path === "bindings"
                ? "export let env, deps; export function bind(e,d){env=e;deps=d;}"
                : 'export {env} from "acceptance:bindings";',
            loader: "js",
          }));
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
            contents: compile(readFileSync(args.path, "utf8"), {
              generate: "server",
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
  const duplicateCache = Object.values(result.metafile.outputs).some((output) =>
    Object.entries(output.inputs).some(
      ([path, input]) => path.endsWith("src/events/anon-cache.ts") && input.bytesInOutput > 0,
    ),
  );
  if (duplicateCache) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error("Acceptance binding drift: Kit bundled a second anon-cache instance");
  }
  const kit = (await import(pathToFileURL(outfile).href)) as KitBinding;
  return {
    request: (request: Request, env: Env) => kit.request(request, env, kitDependencies),
    dispose: () => rmSync(scratch, { recursive: true, force: true }),
  };
}

export async function requestCalendar(
  twin: ArchiveTwin,
  path: string,
  env: Env,
  kit: Awaited<ReturnType<typeof compileArchiveKit>>,
): Promise<Response> {
  const request = new Request(new URL(path, ARCHIVE_ORIGIN));
  return twin === "Hono"
    ? app.request(request, {}, env)
    : dispatchEventsRequest(request, env, () => kit.request(request, env));
}

export async function requestArchive(
  twin: ArchiveTwin,
  path: string,
  env: Env,
  kit: Awaited<ReturnType<typeof compileArchiveKit>>,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(new URL(path, ARCHIVE_ORIGIN), init);
  return twin === "Hono"
    ? app.request(request, {}, env)
    : dispatchPastArchiveRequest(request, env, () => kit.request(request, env));
}
