// Test Author owned. Fixture boundary only; no production/staging connection.
// Transport is discovered from real rendered links/forms, not prescribed here.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Db } from "../../src/db/index";
import type { EventRow } from "../../src/admin/store";
import { drizzle } from "drizzle-orm/pg-proxy";
import { getTableColumns } from "drizzle-orm";
import { events } from "../../src/db/admin-schema";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const origin = "https://next.example.test";
export const key = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const editPath = `/admin/events/${key}`;
// Literal oracle, deliberately not calculated with parseEventListQuery/eventListUrl.
export const inventory =
  "/admin/events?q=Chess+%26+%3Cnight%3E&status=published&series=standalone&fill=has_seats&rsvp_open=1&sort=title&order=asc&page=3";
export const row: EventRow = {
  id: 17,
  eventKey: key,
  title: "Chess & <night>",
  game: "Chess",
  description: "Fixture only",
  startsAt: new Date("2099-11-04T20:00:00Z"),
  endsAt: new Date("2099-11-04T22:00:00Z"),
  timezone: "Europe/London",
  location: "Room",
  capacity: 8,
  status: "published",
  rsvpOpen: true,
  parentEventId: null,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  createdBy: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  createdAt: new Date("2099-01-01T00:00:00Z"),
  updatedAt: new Date("2099-01-01T00:00:00Z"),
  discordEventId: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
};

export type FixtureState = {
  event: EventRow;
  queries: string[];
  audits: unknown[][];
  writes: { operation: string; args: unknown[] }[];
  refusal: "validation" | "stale" | "unavailable" | null;
};

function fixtureDb(state: FixtureState): Db {
  let mode: "list" | "edit" = "edit";
  let slot = 0;
  // Real Drizzle lazy queries and member-read instrumentation; replace only
  // the driver. A fill-filter subquery is not itself an executed statement.
  const db = drizzle(async (sql) => {
    if (sql.includes("set_config")) {
      state.queries.push("bound");
      return { rows: [] };
    }
    state.queries.push(`${mode}:${slot++}`);
    if (/from "events"/.test(sql)) {
      const values = Object.keys(getTableColumns(events)).map((name) => {
        const value = (state.event as unknown as Record<string, unknown>)[name] ?? null;
        return value instanceof Date
          ? value.toISOString()
          : typeof value === "bigint"
            ? String(value)
            : value;
      });
      return { rows: [values] };
    }
    if (/count\(\*\)/i.test(sql)) return { rows: [[0]] };
    return { rows: [] };
  });
  Object.assign(db, {
    prepare(next: "list" | "edit") {
      mode = next;
      slot = 0;
      state.queries.length = 0;
    },
  });
  // pg-proxy deliberately has no transaction transport. This local fixture
  // executes the real transaction callback over the same non-network driver.
  const session = (db as unknown as { session: { transaction: unknown } }).session;
  session.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return db as unknown as Db;
}

export type Harness = Awaited<ReturnType<typeof compileInventoryReturn>>;
export async function compileInventoryReturn() {
  const state: FixtureState = {
    event: { ...row },
    queries: [],
    audits: [],
    writes: [],
    refusal: null,
  };
  const db = fixtureDb(state);
  const namespace = `inventory-return-${Math.random().toString(36).slice(2)}`;
  const stateName = `__${namespace.replaceAll("-", "_")}`;
  // This private per-harness slot is removed by dispose; never shared across suites.
  (globalThis as Record<string, unknown>)[stateName] = { state, db };
  const slot = `globalThis[${JSON.stringify(stateName)}]`;
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const modules: Record<string, string> = {
    kit: `export function error(status,message){throw Object.assign(new Error(message),{status})}`,
    workers: `export const env={APP_URL:${JSON.stringify(origin)}};`,
    db: `export async function dbFor(){return ${slot}.db}`,
    access: `export async function recordAccess(...args){${slot}.state.audits.push(args)}; export async function ensureAccessLogGin(){throw Error('unexpected DDL')}`,
    postgres: `export default function(){throw Error('SQL forbidden in fixture')}`,
    writes: `
      export * from ${JSON.stringify(join(root, "src/admin/store-event-writes.ts"))};
      import { ValidationError } from ${JSON.stringify(join(root, "src/admin/validation.ts"))};
      async function write(operation,args){
        const s=${slot}.state; s.writes.push({operation,args});
        if(s.refusal==='validation')throw new ValidationError({location:'A location is required'});
        if(s.refusal==='stale')throw new ValidationError({status:'The saved event changed; review it before trying again'});
        if(s.refusal==='unavailable')throw Object.assign(new Error('fixture unavailable'),{code:'ECONNREFUSED'});
        return {row:s.event,writeBack:null,childWriteBacks:[]};
      }
      export const updateEvent=(...args)=>write('save',args);
      export const transitionEvent=(...args)=>write(args[3]==='published'?'publish':'cancel',args);
      export const setRsvpOpen=(...args)=>write(args[3]?'rsvp-reopen':'rsvp-pause',args);
    `,
  };
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { Hono } from 'hono';
        import { adminApp } from './src/admin/routes';
        import { sameOrigin } from './src/same-origin';
        import { registerErrorHandlers } from './src/error-registration';
        import { createMemorySessionStore } from './src/sessions';
        import { cookieFor, env, MODERATOR, MEMBER } from './test/helpers/member-data';
        import { load as listLoad } from './web/src/routes/admin/events/+page.server';
        import { load as editLoad } from './web/src/routes/admin/events/[key]/+page.server';
        import { render } from 'svelte/server';
        import List from './web/src/routes/admin/events/+page.svelte';
        import Edit from './web/src/routes/admin/events/[key]/+page.svelte';
        const sessions=createMemorySessionStore();
        const app=new Hono().use('*',sameOrigin).route('/admin',adminApp({sessionStore:sessions,db:${slot}.db}));
        registerErrorHandlers(app);
        export const cookie=async(member=false)=>cookieFor(sessions,member?MEMBER:MODERATOR);
        export const request=(path,init)=>app.request(new URL(path,env.APP_URL),init,{...env,ADMIN_DB:${slot}.db});
        export { listLoad, editLoad };
        export const renderList=data=>render(List,{props:{data}}).body;
        export const renderEdit=data=>render(Edit,{props:{data}}).body;
      `,
      resolveDir: root,
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: namespace,
        setup(plugin) {
          for (const [filter, path] of [
            [/^@sveltejs\/kit$/, "kit"],
            [/^cloudflare:workers$/, "workers"],
            [/src\/admin\/db$/, "db"],
            [/store-access$/, "access"],
            [/store-event-writes$/, "writes"],
            [/^postgres$/, "postgres"],
          ] as const)
            plugin.onResolve({ filter }, () => ({ path, namespace }));
          plugin.onLoad({ filter: /.*/, namespace }, ({ path }) => ({
            contents: modules[path],
            loader: "ts",
            resolveDir: root,
          }));
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
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
    `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
  );
  const cookie: string = await mod.cookie();
  const prepare = (path: string) => {
    (db as unknown as { prepare: (mode: "list" | "edit") => void }).prepare(
      new URL(path, origin).pathname === "/admin/events" ? "list" : "edit",
    );
  };
  return {
    state,
    reset() {
      state.event = { ...row };
      state.refusal = null;
      state.queries.length = state.audits.length = state.writes.length = 0;
    },
    async request(path: string, init: RequestInit = {}) {
      prepare(path);
      return mod.request(path, {
        ...init,
        headers: { cookie, accept: "text/html", ...init.headers },
      }) as Promise<Response>;
    },
    async denied(path: string, member: boolean) {
      prepare(path);
      return mod.request(path, {
        headers: { cookie: member ? await mod.cookie(true) : "" },
      }) as Promise<Response>;
    },
    async document(twin: "Hono" | "Kit", path: string): Promise<string> {
      prepare(path);
      if (twin === "Hono") {
        const response: Response = await mod.request(path, {
          headers: { cookie, accept: "text/html" },
        });
        if (response.status !== 200)
          throw Object.assign(new Error(`fixture GET refused with ${response.status}`), {
            status: response.status,
          });
        return response.text();
      }
      const headers: Record<string, string> = {};
      const event = {
        parent: async () => ({ actor: { id: "100000000000000103", username: "fixture" } }),
        url: new URL(path, origin),
        params: { key },
        setHeaders: (next: Record<string, string>) => Object.assign(headers, next),
      };
      const list = event.url.pathname === "/admin/events";
      const data = await (list ? mod.listLoad : mod.editLoad)(event);
      if (!headers["cache-control"]?.includes("no-store"))
        throw new Error("Kit omitted private no-store");
      return list ? mod.renderList(data) : mod.renderEdit(data);
    },
    async kitDenied(path: string, status: number) {
      prepare(path);
      return mod.editLoad({
        parent: async () => {
          throw Object.assign(new Error("fixture denial"), { status });
        },
        params: { key },
        url: new URL(path, origin),
        setHeaders: () => {
          throw Error("denial set success headers");
        },
      });
    },
    dispose() {
      delete (globalThis as Record<string, unknown>)[stateName];
    },
  };
}

export function decode(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
export function attribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped}=["']([^"']*)["']`).exec(tag);
  return match ? decode(match[1]!) : null;
}
export function links(html: string) {
  return [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map(([tag]) => ({
    href: attribute(tag, "href"),
    text: decode(tag.replace(/<[^>]*>/g, "")).trim(),
    tag,
  }));
}
export function rowLink(html: string): string {
  return (
    links(html).find((link) => new URL(link.href ?? "", origin).pathname === editPath)?.href ??
    editPath
  );
}
export function forms(html: string) {
  return [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(([html]) => {
    const action = attribute(html.slice(0, html.indexOf(">") + 1), "action") ?? "";
    const fields = new URLSearchParams();
    for (const [tag] of html.matchAll(/<input\b(?:"[^"]*"|'[^']*'|[^'">])*>/g)) {
      const name = attribute(tag, "name");
      if (name && !/\bdisabled(?:[\s=>])/.test(tag))
        fields.append(name, attribute(tag, "value") ?? "");
    }
    for (const match of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
      const name = attribute(match[1]!, "name");
      if (name) fields.append(name, decode(match[2]!));
    }
    for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const name = attribute(match[1]!, "name");
      const options = [...match[2]!.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)];
      const chosen = options.find(([tag]) => /\bselected(?:[\s=>])/.test(tag)) ?? options[0];
      if (name && chosen) fields.append(name, attribute(chosen[1]!, "value") ?? decode(chosen[2]!));
    }
    return { html, action, fields };
  });
}
export function post(form: ReturnType<typeof forms>[number]): RequestInit {
  return {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: form.fields.toString(),
  };
}
export function sameInventory(actual: string | null, expected = inventory): boolean {
  if (!actual || !actual.startsWith("/") || actual.startsWith("//")) return false;
  const url = new URL(actual, origin);
  const want = new URL(expected, origin);
  return (
    url.pathname === want.pathname &&
    !url.hash &&
    JSON.stringify([...url.searchParams].sort()) === JSON.stringify([...want.searchParams].sort())
  );
}
