// Acceptance-owned infrastructure: real PostgreSQL predicates and real Hono/Kit
// GET renderers. No event store, scope resolver, query parser or controller fake.
import { build } from "esbuild";
import { drizzle } from "drizzle-orm/postgres-js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Hono } from "hono";
import { adminApp } from "../../src/admin/routes.tsx";
import { events } from "../../src/db/admin-schema.ts";
import { adminSchema, schema } from "../../src/db/index.ts";
import { createMemorySessionStore } from "../../src/sessions.ts";
import { createMemberDataFixture } from "./member-data-db.ts";
import { cookieFor, env, MODERATOR, MEMBER } from "./member-data.ts";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const key = (id) => `01J${String(id).padStart(23, "0")}`;
export const scopeUrl = (id = 100, extra = "") =>
  `/admin/events?series_event=${key(id)}${extra ? `&${extra}` : ""}`;
export const reviewName = "Review occurrences in this series";
export const rowKeys = (html) =>
  [...html.matchAll(/data-testid="event-status-([^"]+)"/g)].map((m) => m[1]);
export const decode = (s) =>
  s.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", '"');
export function links(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: decode(/\bhref="([^"]*)"/.exec(m[1])?.[1] ?? ""),
    text: decode(m[2].replace(/<[^>]*>/g, "").trim()),
    attrs: m[1],
  }));
}
export const reviewLink = (html) => links(html).find((a) => a.text === reviewName);
export const nextLink = (html) => links(html).find((a) => /\brel="next"/.test(a.attrs));

// Deliberately fixed, interleaved identities. Same-title/game decoys are not
// recurrence members; the moved/renamed child is. Equal starts span a page edge.
const start = new Date("2099-11-01T20:00:00Z");
export const fixtureRows = [
  {
    id: 100,
    status: "draft",
    recurrenceFrequency: "weekly",
    recurrenceCount: 30,
    recurrenceIndex: 1,
  },
  {
    id: 200,
    status: "published",
    recurrenceFrequency: "weekly",
    recurrenceCount: 4,
    recurrenceIndex: 1,
  },
  { id: 201, status: "draft", parentEventId: 200, recurrenceIndex: 2 },
  { id: 202, status: "cancelled", parentEventId: 200, recurrenceIndex: 3 },
  { id: 203, status: "past", parentEventId: 200, recurrenceIndex: 4 },
  { id: 300, status: "published" },
  ...Array.from({ length: 29 }, (_, i) => ({
    id: 101 + i,
    status: ["draft", "published", "cancelled", "past"][i % 4],
    parentEventId: 100,
    recurrenceIndex: i + 2,
    ...(i === 0 ? { title: "Renamed occurrence", game: "Different saved game" } : {}),
    rsvpOpen: i % 2 === 0,
  })),
].map((r) => ({
  eventKey: key(r.id),
  title: "Saved <night> & friends",
  game: "Chess",
  description: "Synthetic event description",
  timezone: "UTC",
  capacity: 8,
  rsvpOpen: true,
  ...r,
  startsAt:
    r.id === 128
      ? new Date("2099-11-08T20:00:00Z")
      : r.id === 129
        ? new Date("2099-11-15T20:00:00Z")
        : start,
  endsAt:
    r.id === 128
      ? new Date("2099-11-08T22:00:00Z")
      : r.id === 129
        ? new Date("2099-11-15T22:00:00Z")
        : new Date("2099-11-01T22:00:00Z"),
}));

// Bundle the actual Kit loads and Svelte pages together with their own real
// member-read boundary. Only framework bindings/db injection are substituted;
// imported production query and view functions are not replaced.
export async function compileSeriesKit() {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "exact-series-kit-"),
  );
  const { compile } = createRequire(join(root, "web/package.json"))("svelte/compiler");
  const outfile = join(scratch, "kit.mjs");
  const virtual = new Map([
    [
      "@sveltejs/kit",
      "export function error(status,message){throw Object.assign(new Error(message),{status})}",
    ],
    ["cloudflare:workers", `export const env={APP_URL:${JSON.stringify(env.APP_URL)}};`],
    [
      "fixture-db",
      "let db; export function setDb(value){db=value} export async function dbFor(){return db}",
    ],
  ]);
  try {
    await build({
      stdin: {
        resolveDir: root,
        sourcefile: "exact-series-kit.mjs",
        contents: `
          import { Hono } from 'hono';
          import { render } from 'svelte/server';
          import { setDb } from 'fixture-db';
          import { memberReadDb } from './src/db/member-reads';
          import { memberReadBoundary, bufferedMemberHtml } from './src/member-reads';
          import { load as inventory } from './web/src/routes/admin/events/+page.server';
          import { load as editor } from './web/src/routes/admin/events/[key]/+page.server';
          import Inventory from './web/src/routes/admin/events/+page.svelte';
          import Editor from './web/src/routes/admin/events/[key]/+page.svelte';
          export async function request(path, rawDb, allowed=true) {
            setDb(memberReadDb(rawDb));
            const audit=[]; const app=new Hono();
            app.use('*',(c,next)=>memberReadBoundary(c,
              {viewer:'100000000000000103',resource:'events',action:'list',route:'admin.events.index'},
              async entry=>{audit.push(entry);return true},next));
            app.get('*',async c=>{
              const url=new URL(c.req.url); const match=/^\\/admin\\/events\\/([^/]+)$/.exec(url.pathname);
              const headers={};
              try {
                const data=await (match?editor:inventory)({url,params:{key:match?.[1]},
                  parent:async()=>{if(!allowed)throw Object.assign(new Error('Forbidden'),{status:403});return {}},
                  setHeaders:value=>Object.assign(headers,value)});
                for(const [k,v] of Object.entries(headers))c.header(k,v);
                const rendered=render(match?Editor:Inventory,{props:{data}});
                const shell=${JSON.stringify(readFileSync(join(root, "web/src/app.html"), "utf8"))};
                return bufferedMemberHtml(c,shell.replace('%sveltekit.head%',rendered.head).replace('%sveltekit.body%',rendered.body));
              } catch(e) {
                if(!e.status)throw e;
                return bufferedMemberHtml(c,String(e.message),e.status);
              }
            });
            const response=await app.request('https://next.example.test'+path);
            return {status:response.status,headers:Object.fromEntries(response.headers),html:await response.text(),audit};
          }`,
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "silent",
      tsconfigRaw: { compilerOptions: {} },
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      plugins: [
        {
          name: "exact-series-kit",
          setup(plugin) {
            plugin.onResolve(
              { filter: /^(@sveltejs\/kit|cloudflare:workers|fixture-db)$/ },
              ({ path }) => ({ path, namespace: "fixture" }),
            );
            plugin.onResolve({ filter: /src\/admin\/db$/ }, () => ({
              path: "fixture-db",
              namespace: "fixture",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
              contents: virtual.get(path),
              loader: "js",
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
    const kit = await import(pathToFileURL(outfile).href);
    return {
      request: kit.request,
      dispose: () => rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    throw e;
  }
}

export async function createSeriesFixture() {
  // No skip/fallback: CI supplies its disposable database; local commands supply
  // the README-approved run-owned URL. The shared guard runs before connecting.
  const fixture = await createMemberDataFixture(process.env.DATABASE_URL);
  try {
    await fixture.db.insert(events).values(fixtureRows.slice(0, 1));
    await fixture.db.insert(events).values(fixtureRows.slice(1));
    const queries = [];
    const db = drizzle(fixture.client, {
      schema: { ...schema, ...adminSchema },
      logger: {
        logQuery(sql, params) {
          queries.push({ sql, params });
        },
      },
    });
    const store = createMemorySessionStore();
    const moderator = await cookieFor(store, MODERATOR);
    const member = await cookieFor(store, MEMBER);
    const app = new Hono().route("/admin", adminApp({ sessionStore: store, db }));
    return {
      ...fixture,
      db,
      queries,
      async rejectedDraft(id = 101) {
        queries.length = 0;
        const response = await app.request(
          `/admin/events/${key(id)}`,
          {
            method: "POST",
            headers: {
              cookie: moderator,
              origin: env.APP_URL,
              "content-type": "application/x-www-form-urlencoded",
              accept: "text/html",
            },
            body: new URLSearchParams({
              title: "UNSAVED other series",
              game: "Other unsaved game",
              description: "Unsaved copy",
              starts_at: "2099-11-01 20:00",
              ends_at: "2099-11-01 22:00",
              timezone: "UTC",
              capacity: "0",
              parent_event_id: "200",
              recurrence_frequency: "weekly",
              series_event: key(200),
            }),
          },
          { ...env, ADMIN_DB: db },
        );
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          html: await response.text(),
        };
      },
      async request(twin, kit, path, actor = "moderator", overrideDb = db) {
        queries.length = 0;
        if (twin === "Kit") return kit.request(path, overrideDb, actor === "moderator");
        const application =
          overrideDb === db
            ? app
            : new Hono().route("/admin", adminApp({ sessionStore: store, db: overrideDb }));
        const response = await application.request(
          path,
          {
            headers: actor === "guest" ? {} : { cookie: actor === "member" ? member : moderator },
          },
          { ...env, ADMIN_DB: overrideDb },
        );
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          html: await response.text(),
        };
      },
    };
  } catch (e) {
    await fixture.dispose();
    throw e;
  }
}
