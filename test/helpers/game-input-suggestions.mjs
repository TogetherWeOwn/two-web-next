// Independent local fixtures for the published-game input assistance contract.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { parse } from "parse5";
import { serializeSigned } from "hono/utils/cookie";
import { events } from "../../src/db/admin-schema";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

export const ORIGIN = "https://game-input.example.test";
export const VIEWER = "100000000000000201";
export const KEY = "01J0000000000000000000ABCD";
export const HOSTILE = '\"><img src=x onerror=alert(1)> & 雪';
export const PUBLISHED = ["Chess", "chess", "D&D", "All", "囲碁 / 雪", HOSTILE, "Historic only"];
export const records = [
  ...PUBLISHED.map((game) => ({ game, status: "published", endsAt: "2001-01-01" })),
  { game: "PRIVATE DRAFT CANARY", status: "draft", endsAt: "2099-01-01" },
  { game: "CANCELLED CANARY", status: "cancelled", endsAt: "2099-01-01" },
  { game: null, status: "published", endsAt: "2099-01-01" },
  { game: "  ", status: "published", endsAt: "2099-01-01" },
];

export function eventRow() {
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Local game night",
    game: "Unlisted custom game",
    description: "A local fixture",
    accessibilityNotes: null,
    startsAt: new Date("2099-06-01T18:00:00Z"),
    endsAt: new Date("2099-06-01T20:00:00Z"),
    timezone: "UTC",
    location: "Hall",
    capacity: 8,
    status: "draft",
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: VIEWER,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: new Date("2099-01-01T00:00:00Z"),
    updatedAt: new Date("2099-01-01T00:00:00Z"),
  };
}

export function fixtureDb({ catalogError, catalog = records, row = eventRow(), auditError } = {}) {
  const statements = [];
  const columns = Object.keys(getTableColumns(events));
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params: [...params] });
    if (/select distinct/i.test(sql) && /game/i.test(sql)) {
      if (catalogError) throw catalogError;
      // Evaluate the existing SQL boundary, not a proposed assistance helper.
      const publishedOnly = /status"?\s*=\s*'published'/i.test(sql) || params.includes("published");
      const limitIndex = Number(/limit \$(\d+)/i.exec(sql)?.[1]) - 1;
      const limit =
        Number.isInteger(limitIndex) && limitIndex >= 0 ? Number(params[limitIndex]) : Infinity;
      const games = [
        ...new Set(
          catalog
            .filter((r) => !publishedOnly || r.status === "published")
            .map((r) => r.game?.trim())
            .filter(Boolean),
        ),
      ].sort();
      return { rows: games.slice(0, limit).map((game) => [game]) };
    }
    if (sql.includes("from rsvps") && sql.includes("count(*)")) {
      return {
        rows: [
          { user_id: VIEWER, username: "Fixture member", count: 3 },
          { user_id: "100000000000000202", username: "Fixture other", count: 1 },
        ],
      };
    }
    if (/^select count\(\*\)/i.test(sql)) return { rows: [[1]] };
    if (/from "rsvps"/.test(sql) && /^select /i.test(sql)) {
      return {
        rows: [
          [
            "100000000000000202",
            "100000000000000202",
            "Fixture other",
            "going",
            "2099-01-01T00:00:00Z",
          ],
        ],
      };
    }
    if (/from "events"/.test(sql) && /^select /i.test(sql)) {
      return {
        rows: row
          ? [columns.map((k) => (row[k] instanceof Date ? row[k].toISOString() : (row[k] ?? null)))]
          : [],
      };
    }
    if (/insert into "member_data_access_logs"/.test(sql) && auditError) throw auditError;
    return { rows: [] };
  });
  Object.assign(db, { transaction: async (fn) => fn(db) });
  return {
    db,
    statements,
    catalogReads: () =>
      statements.filter((s) => /select distinct/i.test(s.sql) && /game/i.test(s.sql)),
  };
}

export async function fixtureEnv(db, { moderator = true, member = true, guest = false } = {}) {
  const sessions = createMemorySessionStore();
  const secret = "test-session-secret-at-least-32-bytes-long";
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: VIEWER,
    username: "Fixture member",
    avatar: null,
    member,
    moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = guest
    ? ""
    : (
        await serializeSigned("__Host-two_session", token, secret, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0];
  return {
    cookie,
    env: {
      APP_URL: ORIGIN,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/example",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET: secret,
      SESSION_STORE: sessions,
      ADMIN_DB: db,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    },
  };
}

export function nodes(html) {
  const all = [];
  function visit(node) {
    if (node.tagName) all.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(parse(html));
  return all;
}
export const attr = (node, name) => node?.attrs?.find((a) => a.name === name)?.value;
export function text(node) {
  return node?.nodeName === "#text" ? node.value : (node?.childNodes ?? []).map(text).join("");
}
export function gameControl(html, name) {
  const all = nodes(html);
  const input = all.find((n) => n.tagName === "input" && attr(n, "name") === name);
  const list = all.find((n) => n.tagName === "datalist" && attr(n, "id") === attr(input, "list"));
  return {
    all,
    input,
    list,
    values: (list?.childNodes ?? [])
      .filter((n) => n.tagName === "option")
      .map((n) => attr(n, "value") ?? text(n)),
  };
}
export const cacheTokens = (response) =>
  (response.headers.get("cache-control") ?? "")
    .split(",")
    .map((v) => v.trim())
    .sort();
export const outage = () =>
  Object.assign(new Error("fixture catalog unavailable"), { code: "ECONNREFUSED" });

// Executes the actual three Kit loads/pages, not a handwritten rendering twin.
// Adapted from the existing member-period/roster SSR fixture transport.
export async function compileSuggestionKit() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const { compile } = createRequire(join(root, "web/package.json"))("svelte/compiler");
  const styles = [];
  const built = await build({
    stdin: {
      contents: `
import {render} from "svelte/server";
import Board from "./web/src/routes/leaderboards/members/+page.svelte";
import BoardError from "./web/src/routes/leaderboards/members/+error.svelte";
import {page} from "$app/state";
import Create from "./web/src/routes/admin/events/new/+page.svelte";
import Edit from "./web/src/routes/admin/events/[key]/+page.svelte";
import {load as boardLoad} from "./web/src/routes/leaderboards/members/+page.server.ts";
import {load as createLoad} from "./web/src/routes/admin/events/new/+page.server.ts";
import {load as editLoad} from "./web/src/routes/admin/events/[key]/+page.server.ts";
import {load as layout} from "./web/src/routes/admin/+layout.server.ts";
import {memberReadResponse} from "./src/member-reads.ts";
import {recordAccess} from "./src/admin/store-access.ts";
import {recordQueuedMembersBoardView} from "./src/kit-members.ts";
import {setEnv} from "cloudflare:workers";
export const loads={board:boardLoad,create:createLoad,edit:editLoad};
const pages={board:Board,create:Create,edit:Edit};
export function html(surface,data) {
  const {head,body}=render(pages[surface],{props:{data}});
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'+head+'</head><body>'+body+'</body></html>';
}
export async function request({surface,env,path,member=true,moderator=true,guest=false}) {
  setEnv(env);
  const url=new URL(path,env.APP_URL);
  const headers=new Headers({'content-type':'text/html'});
  const setHeaders=values=>Object.entries(values).forEach(([key,value])=>headers.set(key,value));
  const locals={status:guest?'guest':'authenticated',session:guest?null:{userId:'${VIEWER}',username:'Fixture member',member,moderator}};
  let data;
  const response=await memberReadResponse(
    {method:'GET',route:surface==='board'?'/leaderboards/members':'/admin/events/'+(surface==='create'?'new':':key')},
    {viewer:'${VIEWER}',resource:surface==='board'?'leaderboard':'events',action:surface==='board'?'list':'view',route:surface==='board'?'leaderboards.members':'admin.events.'+(surface==='create'?'create':'edit')},
    entry=>recordAccess(env.ADMIN_DB,entry),
    async()=>{
      try {
        data=await loads[surface]({url,locals,params:{key:'${KEY}'},cookies:{set(){},delete(){}},setHeaders,parent:()=>layout({locals,url,setHeaders})});
        return new Response(html(surface,data),{headers});
      } catch(err) {
        if(![302,400,403,404,503].includes(err?.status)) throw err;
        if(err.location) headers.set('location',err.location);
        if(surface==='board' && err.status===400) {
          Object.assign(page,{status:400,error:{message:err.body?.message??err.message},url});
          const {head,body}=render(BoardError);
          return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'+head+'</head><body>'+body+'</body></html>',{status:400,headers});
        }
        return new Response('',{status:err.status,headers});
      }
    },
    released=>recordQueuedMembersBoardView(locals,released.status)
  );
  return {response,data};
}
export {setEnv};
`,
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    banner: {
      js: `import {createRequire as fixtureRequire} from 'node:module'; const require=fixtureRequire(${JSON.stringify(join(root, "package.json"))});`,
    },
    plugins: [
      {
        name: "game-suggestions-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "bindings",
            namespace: "game-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "game-fixture" }, () => ({
            contents:
              "let current={};export const setEnv=v=>{current=v;};export const env=new Proxy({},{get:(_,k)=>Reflect.get(current,k)});",
            loader: "js",
          }));
          plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
            path: "page-state",
            namespace: "game-page",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "game-page" }, () => ({
            contents:
              "export const page={status:200,error:null,url:new URL('https://game-input.example.test')};",
            loader: "js",
          }));
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const { js, css } = compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            });
            if (css?.code) styles.push(css.code);
            return { contents: js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  const compiled = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`
  );
  return { ...compiled, css: styles.join("\n") };
}
