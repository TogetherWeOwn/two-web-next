// Independent mapped-result fixture, not a PostgreSQL corruption experiment.
// Real SQL, classification, audit, Hono routes and Kit loads/templates execute.
// The adapter returns rows in supplied DB order; it never formats or sorts dates.
import { drizzle } from "drizzle-orm/postgres-js";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { adminApp } from "../../src/admin/routes";
import { dbFor, type EnvWithAdminDb } from "../../src/admin/db";
import { listActivityLog, listRoster } from "../../src/admin/reads";
import { getEvent } from "../../src/admin/store-event-reads";
import { recordAccess } from "../../src/admin/store-access";
import type { EventRow } from "../../src/admin/store";
import type { Db } from "../../src/db/index";
import type { KitLocals } from "../../src/kit-session";
import { dispatchHookRequest, ROUTE_MANIFEST } from "../../src/route-ownership";
import { createMemorySessionStore } from "../../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./member-data";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const eventKey = "01J0000000000000000000CHRN";
// Literal calendar expectations: no Intl/Date formatting from the code under test.
// Accept unambiguous day-first, month-first or year-first dates, not one copy style.
export const instants = [
  {
    iso: "2026-10-01T12:34:56.789Z",
    date: /\b(?:0?1 Oct(?:ober)?[,]? 2026|Oct(?:ober)? 0?1[,]? 2026|2026-10-01)\b/i,
    clock: "12:34",
  },
  {
    iso: "2026-12-31T23:59:59.999Z",
    date: /\b(?:31 Dec(?:ember)?[,]? 2026|Dec(?:ember)? 31[,]? 2026|2026-12-31)\b/i,
    clock: "23:59",
  },
  {
    iso: "2027-01-01T00:00:00.000Z",
    date: /\b(?:0?1 Jan(?:uary)?[,]? 2027|Jan(?:uary)? 0?1[,]? 2027|2027-01-01)\b/i,
    clock: "00:00",
  },
  {
    iso: "2028-02-29T00:01:00.123Z",
    date: /\b(?:29 Feb(?:ruary)?[,]? 2028|Feb(?:ruary)? 29[,]? 2028|2028-02-29)\b/i,
    clock: "00:01",
  },
  {
    iso: "1970-01-01T00:00:00.000Z",
    date: /\b(?:0?1 Jan(?:uary)?[,]? 1970|Jan(?:uary)? 0?1[,]? 1970|1970-01-01)\b/i,
    clock: "00:00",
  },
] as const;

export const unusable = [
  { name: "Invalid Date", value: new Date(Number.NaN) },
  { name: "null", value: null },
  { name: "missing", value: undefined },
  { name: "empty wire value", value: "" },
  { name: "malformed wire value", value: "not-a-timestamp" },
  { name: "nonfinite number", value: Number.POSITIVE_INFINITY },
  { name: "NaN", value: Number.NaN },
] as const;

const event: EventRow = {
  id: 17,
  eventKey,
  title: "Chronology fixture night",
  game: "Chess",
  description: "Saved event copy",
  location: "Fixture room",
  timezone: "UTC",
  capacity: 8,
  startsAt: new Date("2099-11-04T20:00:00Z"),
  endsAt: new Date("2099-11-04T22:00:00Z"),
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  status: "draft",
  rsvpOpen: true,
  createdBy: null,
  createdAt: new Date("2026-01-01T12:00:00Z"),
  updatedAt: new Date("2026-01-01T12:00:00Z"),
};

export function rosterRow(timestamp: unknown, index = 0) {
  const id = String(100000000000080001n + BigInt(index));
  return {
    userId: id,
    memberId: id,
    username: ["Zed response", "Middle response", "Ada response"][index] ?? `Response ${index}`,
    status: index === 1 ? "waitlisted" : "going",
    answeredAt: timestamp,
  };
}
export function activityRow(timestamp: unknown, index = 0) {
  return {
    id: 900 - index,
    description: `Chronology action ${index}`,
    subjectType: "Event",
    subjectId: eventKey,
    causerId: index === 1 ? "42" : "100000000000080011",
    event: "updated",
    createdAt: timestamp,
  };
}

export function chronologyDb(
  options: {
    roster?: ReturnType<typeof rosterRow>[];
    activity?: ReturnType<typeof activityRow>[];
    total?: number;
    auditFails?: boolean;
    queryError?: Error;
  } = {},
) {
  const statements: { sql: string; params: unknown[]; fields: string[] }[] = [];
  const audits: Record<string, unknown>[] = [];
  let mutations = 0;
  const db = drizzle.mock() as unknown as Db;
  const session = (
    db as unknown as {
      session: {
        transaction: (work: (tx: Db) => Promise<unknown>) => Promise<unknown>;
        prepareQuery: (...args: any[]) => unknown;
      };
    }
  ).session;
  session.transaction = async (work) => work(db);
  session.prepareQuery = (
    query: { sql: string; params: unknown[] },
    fields?: { path: string[] }[],
  ) => ({
    setToken() {
      return this;
    },
    execute: async () => {
      const sql = query.sql.replace(/\s+/g, " ").trim();
      const params = query.params;
      statements.push({
        sql,
        params: [...params],
        fields: fields?.map((f) => f.path.join(".")) ?? [],
      });
      if (sql.startsWith("select set_config('lock_timeout'")) return [];
      if (sql.startsWith('insert into "member_data_access_logs"')) {
        if (options.auditFails) throw new Error("fixture audit unavailable");
        const columns = sql
          .match(/\((.*?)\) values/)![1]!
          .split(", ")
          .map((s) => s.replaceAll('"', ""));
        const values = sql.match(/values \((.*?)\)/)![1]!.split(", ");
        audits.push(
          Object.fromEntries(
            columns.map((c, i) => {
              const slot = values[i]!.match(/^\$(\d+)$/);
              return [c, slot ? params[Number(slot[1]) - 1] : null];
            }),
          ),
        );
        return [];
      }
      if (!sql.startsWith("select ")) {
        mutations++;
        throw new Error(`unexpected fixture mutation: ${sql}`);
      }
      if (options.queryError) throw options.queryError;
      if (sql.includes('from "rsvps"')) {
        if (sql.startsWith("select count(*)"))
          return [{ n: options.total ?? options.roster?.length ?? 0 }];
        return options.roster ?? [];
      }
      if (sql.includes('from "activity_log"')) return options.activity ?? [];
      if (sql.includes('from "events"')) return [{ ...event }];
      throw new Error(`unsupported fixture read: ${sql}`);
    },
  });
  return {
    db,
    statements,
    audits,
    get mutations() {
      return mutations;
    },
  };
}
export type ChronologyDb = ReturnType<typeof chronologyDb>;
export type Surface = "roster" | "activity";
export type Renderer = "Hono" | "Kit";

// Bridge the real read functions so the compiled loads share the request's
// AsyncLocalStorage classifier. Only Worker/Kit environment bindings are faked.
export async function compileChronologyKit() {
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const modules: Record<string, string> = {
    bridge: "export const state = {};",
    db: 'import {state} from "bridge"; export const dbFor=(...a)=>state.dbFor(...a);',
    reads:
      'import {state} from "bridge"; export const listRoster=(...a)=>state.listRoster(...a); export const listActivityLog=(...a)=>state.listActivityLog(...a);',
    event: 'import {state} from "bridge"; export const getEvent=(...a)=>state.getEvent(...a);',
    env: `export const env=${JSON.stringify(env)};`,
    kit: "export function error(status,message){throw Object.assign(new Error(message),{status});} export function redirect(status,location){throw Object.assign(new Error('redirect'),{status,location});}",
  };
  const built = await build({
    stdin: {
      contents: `
        import {state} from "bridge";
        import {render} from "svelte/server";
        import {load as layout} from "./web/src/routes/admin/+layout.server.ts";
        import {load as loadRoster} from "./web/src/routes/admin/events/[key]/+page.server.ts";
        import {load as loadActivity} from "./web/src/routes/admin/activity-log/+page.server.ts";
        import Roster from "./web/src/routes/admin/events/[key]/+page.svelte";
        import Activity from "./web/src/routes/admin/activity-log/+page.svelte";
        export const configure=(deps)=>Object.assign(state,deps);
        export {layout,loadRoster,loadActivity};
        export const html=(surface,data)=>render(surface==='roster'?Roster:Activity,{props:{data}}).body;
      `,
      resolveDir: root,
      sourcefile: "admin-chronology-ssr.mjs",
    },
    absWorkingDir: root,
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    logLevel: "silent",
    plugins: [
      {
        name: "chronology-fixture-bindings",
        setup(p) {
          p.onResolve({ filter: /^bridge$/ }, () => ({ path: "bridge", namespace: "chronology" }));
          for (const [filter, name] of [
            [/^@sveltejs\/kit$/, "kit"],
            [/^cloudflare:workers$/, "env"],
            [/src\/admin\/db$/, "db"],
            [/src\/admin\/reads$/, "reads"],
            [/src\/admin\/store-event-reads$/, "event"],
          ] as const)
            p.onResolve({ filter }, () => ({ path: name, namespace: "chronology" }));
          p.onResolve({ filter: /^\.\/(?:db|reads)$/ }, ({ path, importer }) =>
            importer === join(root, "src/admin/kit-activity-log.ts")
              ? { path: path.slice(2), namespace: "chronology" }
              : null,
          );
          p.onLoad({ filter: /.*/, namespace: "chronology" }, ({ path }) => ({
            contents: modules[path]!,
            loader: "js",
          }));
          p.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
            contents: compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            }).js.code,
            loader: "js",
            resolveDir: dirname(path),
          }));
        },
      },
    ],
  });
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`
  );
  mod.configure({ dbFor, listRoster, listActivityLog, getEvent });
  return mod as {
    configure: (deps: Record<string, unknown>) => void;
    layout: (args: Record<string, unknown>) => Promise<unknown>;
    loadRoster: (args: Record<string, unknown>) => Promise<any>;
    loadActivity: (args: Record<string, unknown>) => Promise<any>;
    html: (surface: Surface, data: unknown) => string;
  };
}
export type ChronologyKit = Awaited<ReturnType<typeof compileChronologyKit>>;

export async function readChronology(
  renderer: Renderer,
  surface: Surface,
  fixture: ChronologyDb,
  kit: ChronologyKit,
  query = "",
  admission: "moderator" | "member" | "guest" = "moderator",
) {
  const localPath = surface === "roster" ? `/events/${eventKey}` : "/activity-log";
  const suffix = query ? `?${query}` : "";
  let data: any;
  if (renderer === "Hono") {
    const store = createMemorySessionStore();
    const cookie =
      admission === "guest"
        ? ""
        : await cookieFor(store, admission === "moderator" ? MODERATOR : MEMBER);
    const response = await adminApp({ sessionStore: store, db: fixture.db }).request(
      localPath + suffix,
      { headers: { cookie } },
      { ...env, ADMIN_DB: fixture.db },
    );
    return { response, data };
  }
  const kitEnv: EnvWithAdminDb = { ...env, ADMIN_DB: fixture.db };
  kit.configure({ dbFor: () => dbFor({ env: kitEnv }) });
  const request = new Request(`${env.APP_URL}/admin${localPath}${suffix}`);
  const url = new URL(request.url);
  const locals: KitLocals = {
    status: admission === "guest" ? "guest" : "authenticated",
    session:
      admission === "guest"
        ? null
        : {
            userId: admission === "moderator" ? MODERATOR.userId : MEMBER.userId,
            username: "fixture moderator",
            avatar: null,
            member: true,
            moderator: admission === "moderator",
          },
    returnTo: null,
    joinResult: null,
    expiredWrite: null,
  };
  const routePath = surface === "roster" ? "/admin/events/:key" : "/admin/activity-log";
  const manifest = ROUTE_MANIFEST.map((r) =>
    r.path === routePath && r.method === "GET" ? { ...r, enabled: true } : r,
  );
  const response = await dispatchHookRequest(
    {
      request,
      url,
      route: { id: surface === "roster" ? "/admin/events/[key]" : "/admin/activity-log" },
    },
    {
      appUrl: env.APP_URL,
      featuredImageHosts: "",
      manifest,
      honoFetch: async () => {
        throw new Error("unexpected Hono fallback in Kit fixture");
      },
      sessionFor: async () => locals,
      accessSink: async () => (entry) => recordAccess(fixture.db, entry),
      resolve: async () => {
        const headers: Record<string, string> = {};
        const setHeaders = (h: Record<string, string>) => Object.assign(headers, h);
        try {
          data = await (surface === "roster" ? kit.loadRoster : kit.loadActivity)({
            parent: () => kit.layout({ locals, url, setHeaders }),
            params: { key: eventKey },
            url,
            setHeaders,
          });
          // Exercise the actual model's finite wire values, not hand-made template props.
          const wire = JSON.parse(JSON.stringify(data));
          return new Response(kit.html(surface, wire), {
            headers: { ...headers, "content-type": "text/html; charset=UTF-8" },
          });
        } catch (err) {
          const failure = err as { status?: number; location?: string };
          if (failure.status === 302 && failure.location)
            return new Response(null, {
              status: 302,
              headers: { ...headers, location: failure.location },
            });
          if (failure.status === 403 || failure.status === 503)
            return new Response("Admin unavailable", { status: failure.status, headers });
          throw err;
        }
      },
    },
  );
  return { response, data };
}

export type HtmlNode = DefaultTreeAdapterTypes.Node;
export type HtmlElement = DefaultTreeAdapterTypes.Element;
export const documentOf = (html: string) => parse(html);
export function elements(node: HtmlNode, tag?: string): HtmlElement[] {
  const own = "tagName" in node && (!tag || node.tagName === tag) ? [node] : [];
  return own.concat("childNodes" in node ? node.childNodes.flatMap((c) => elements(c, tag)) : []);
}
export const attr = (node: HtmlElement, name: string) =>
  node.attrs.find((a) => a.name === name)?.value;
export function text(node: HtmlNode): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterTypes.TextNode).value;
  return "childNodes" in node ? node.childNodes.map(text).join("").replace(/\s+/g, " ").trim() : "";
}
export function tableOf(html: string, surface: Surface) {
  const id = surface === "roster" ? "roster-table" : "activity-log-table";
  const table = elements(documentOf(html), "table").find((e) => attr(e, "data-testid") === id);
  if (!table) throw new Error(`missing ${id} in rendered response`);
  return table;
}
export function cellsOf(html: string, surface: Surface) {
  const tbody = elements(tableOf(html, surface), "tbody")[0]!;
  return elements(tbody, "tr").map((row) => elements(row, "td"));
}
