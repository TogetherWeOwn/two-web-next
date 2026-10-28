// Independent fixture for the RSVP-answer facet. No network or database connection.
// Real Drizzle SQL, read classification, keyed attribution, guards, Hono handler,
// Kit load and executed Svelte SSR stay in the path. Only the mapped DB adapter
// and framework/environment bindings are replaced. This is not a PostgreSQL proof.
import { build } from "esbuild";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminApp } from "../../src/admin/routes";
import { dbFor, type EnvWithAdminDb } from "../../src/admin/db";
import { listRoster } from "../../src/admin/reads";
import { getEvent } from "../../src/admin/store-event-reads";
import { recordAccess } from "../../src/admin/store-access";
import type { EventRow } from "../../src/admin/store";
import type { Db } from "../../src/db/index";
import { createMemorySessionStore } from "../../src/sessions";
import { dispatchHookRequest, ROUTE_MANIFEST } from "../../src/route-ownership";
import type { KitLocals } from "../../src/kit-session";
import { cookieFor, env, MEMBER, MODERATOR } from "./member-data";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const key = "01J0000000000000000000ABCD";
export const path = `/admin/events/${key}`;
export const statuses = ["going", "waitlisted", "maybe", "not_going"] as const;
export const needle = "Café %_\\ Team";
export const idFor = (i: number, status: number) =>
  String(100000000000010000n + BigInt(i * 4 + status));
export const row: EventRow = {
  id: 17,
  eventKey: key,
  title: "Fixture game night",
  game: "Chess",
  description: "Saved event copy",
  location: "Saved room",
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
  status: "published",
  rsvpOpen: true,
  createdBy: null,
  createdAt: new Date("2026-01-01T12:00:00Z"),
  updatedAt: new Date("2026-01-01T12:00:00Z"),
};
type Answer = {
  eventKey: string;
  userId: string;
  memberId: string | null;
  username: string | null;
  status: string;
  answeredAt: Date;
};
export type Statement = { sql: string; params: unknown[]; fields: string[] };

function like(pattern: string, value: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    let c = pattern[i]!;
    if (c === "\\") c = pattern[++i] ?? "\\";
    else if (c === "%") {
      regex += ".*";
      continue;
    } else if (c === "_") {
      regex += ".";
      continue;
    }
    regex += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${regex}$`, "iu").test(value);
}

export function rosterDb(options: { auditFails?: boolean; noAnswers?: boolean } = {}) {
  const answers: Answer[] = [];
  if (!options.noAnswers) {
    for (let i = 104; i >= 0; i--)
      for (let s = 3; s >= 0; s--) {
        const userId = idFor(i, s);
        const orphan = s === 2 && i === 104;
        answers.push({
          eventKey: key,
          userId,
          memberId: orphan ? null : userId,
          username: orphan ? null : `${needle} ${i}`,
          status: statuses[s]!,
          answeredAt: new Date("2026-10-01T12:00:00Z"),
        });
      }
    // Same names and statuses on a different event must never affect totals/subjects.
    for (let s = 0; s < 4; s++)
      answers.push({
        eventKey: "01J0000000000000000000ZZZZ",
        userId: String(100000000000090000n + BigInt(s)),
        memberId: String(100000000000090000n + BigInt(s)),
        username: needle,
        status: statuses[s]!,
        answeredAt: new Date("2026-10-02T12:00:00Z"),
      });
  }
  const statements: Statement[] = [];
  const audits: Record<string, unknown>[] = [];
  let mutations = 0;
  const db = drizzle.mock() as unknown as Db;
  const session = (
    db as unknown as {
      session: {
        prepareQuery: (...args: any[]) => unknown;
        transaction: (work: (tx: Db) => Promise<unknown>) => Promise<unknown>;
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
      if (sql.includes('from "events"') && !sql.includes('from "rsvps"')) return [{ ...row }];
      if (!sql.includes('from "rsvps"')) throw new Error(`unsupported fixture read: ${sql}`);
      const where = sql.split(" where ")[1]?.split(/ order by | limit /)[0] ?? "";
      const param = (re: RegExp) => {
        const m = where.match(re);
        return m ? params[Number(m[1]) - 1] : undefined;
      };
      const event = param(/"events"\."event_key" = \$(\d+)/);
      const status = param(/"rsvps"\."status" = \$(\d+)/);
      const search = param(/"users"\."username" ilike \$(\d+)/i);
      if (event === undefined) throw new Error("fixture requires bound event predicate");
      let selected = answers.filter(
        (a) =>
          a.eventKey === event &&
          (status === undefined || a.status === status) &&
          (search === undefined || (a.username !== null && like(String(search), a.username))),
      );
      if (sql.startsWith("select count(*)")) return [{ n: selected.length }];
      const order = sql.match(
        /order by "rsvps"\."(status|updated_at)" (asc|desc), "rsvps"\."user_id"(?: asc)? limit/,
      );
      if (!order) throw new Error("fixture requires deterministic roster order");
      selected = selected.sort((a, b) => {
        const left = order[1] === "status" ? a.status : a.answeredAt.toISOString();
        const right = order[1] === "status" ? b.status : b.answeredAt.toISOString();
        const primary = left < right ? -1 : left > right ? 1 : 0;
        return primary * (order[2] === "desc" ? -1 : 1) || a.userId.localeCompare(b.userId);
      });
      const limit = sql.match(/ limit \$(\d+)/);
      const offset = sql.match(/ offset \$(\d+)/);
      if (!limit) throw new Error("fixture refuses an unbounded roster page");
      const start = offset ? Number(params[Number(offset[1]) - 1]) : 0;
      return selected
        .slice(start, start + Number(params[Number(limit[1]) - 1]))
        .map(({ eventKey: _eventKey, ...a }) => a);
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
export type RosterFixture = ReturnType<typeof rosterDb>;

// The actual Kit load is executed, not a source-text pin. Bridge the real shared
// reads into the bundle so its AsyncLocalStorage is the request's own boundary.
export async function compileRosterKit() {
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const page = join(root, "web/src/routes/admin/events/[key]/+page.svelte");
  const load = join(root, "web/src/routes/admin/events/[key]/+page.server.ts");
  const layout = join(root, "web/src/routes/admin/+layout.server.ts");
  const bridgeModules: Record<string, string> = {
    bridge: "export const state = {};",
    db: 'import {state} from "bridge"; export const dbFor=(...a)=>state.dbFor(...a);',
    reads: 'import {state} from "bridge"; export const listRoster=(...a)=>state.listRoster(...a);',
    event: 'import {state} from "bridge"; export const getEvent=(...a)=>state.getEvent(...a);',
    env: 'import {state} from "bridge"; export const env=state.env;',
    kit: "export function error(status,message){throw Object.assign(new Error(message),{status});} export function redirect(status,location){throw Object.assign(new Error('redirect'),{status,location});}",
  };
  // env is exported as an object before configure() runs, so use the fixed safe fixture.
  bridgeModules.env = `export const env=${JSON.stringify(env)};`;
  const built = await build({
    stdin: {
      contents: `import {state} from "bridge"; import {load} from ${JSON.stringify(load)}; import {load as layout} from ${JSON.stringify(layout)}; import P from ${JSON.stringify(page)}; import {render} from "svelte/server"; export function configure(deps){Object.assign(state,deps);} export {load,layout}; export const html=(data)=>render(P,{props:{data}}).body;`,
      resolveDir: root,
      sourcefile: "roster-status-ssr.mjs",
    },
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
        name: "roster-fixture-bindings",
        setup(p) {
          p.onResolve({ filter: /^bridge$/ }, () => ({
            path: "bridge",
            namespace: "roster-fixture",
          }));
          for (const [filter, name] of [
            [/^@sveltejs\/kit$/, "kit"],
            [/^cloudflare:workers$/, "env"],
            [/src\/admin\/db$/, "db"],
            [/src\/admin\/reads$/, "reads"],
            [/src\/admin\/store-event-reads$/, "event"],
          ] as const)
            p.onResolve({ filter }, () => ({ path: name, namespace: "roster-fixture" }));
          p.onLoad({ filter: /.*/, namespace: "roster-fixture" }, ({ path }) => ({
            contents: bridgeModules[path]!,
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
  const compiled = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`
  );
  compiled.configure({ dbFor, listRoster, getEvent });
  return compiled as {
    load: (event: {
      parent: () => Promise<unknown>;
      params: { key: string };
      url: URL;
      setHeaders: (headers: Record<string, string>) => void;
    }) => Promise<unknown>;
    layout: (event: {
      locals: KitLocals;
      url: URL;
      setHeaders: (headers: Record<string, string>) => void;
    }) => Promise<unknown>;
    html: (data: unknown) => string;
    configure: (deps: Record<string, unknown>) => void;
  };
}
export type RosterKit = Awaited<ReturnType<typeof compileRosterKit>>;
export type Renderer = "Hono" | "Kit";
export type Admission = "moderator" | "member" | "guest";

export async function readRoster(
  renderer: Renderer,
  fixture: RosterFixture,
  query = "",
  kit?: RosterKit,
  admission: Admission = "moderator",
) {
  if (renderer === "Hono") {
    const store = createMemorySessionStore();
    const cookie =
      admission === "guest"
        ? ""
        : await cookieFor(store, admission === "moderator" ? MODERATOR : MEMBER);
    return adminApp({ sessionStore: store, db: fixture.db }).request(
      `/events/${key}${query ? `?${query}` : ""}`,
      { headers: { cookie } },
      { ...env, ADMIN_DB: fixture.db },
    );
  }
  if (!kit) throw new Error("compile Kit fixture before rendering");
  const kitEnv: EnvWithAdminDb = { ...env, ADMIN_DB: fixture.db };
  kit.configure({ dbFor: () => dbFor({ env: kitEnv }) });
  const request = new Request(`${env.APP_URL}${path}${query ? `?${query}` : ""}`);
  const url = new URL(request.url);
  const locals: KitLocals = {
    status: admission === "guest" ? "guest" : "authenticated",
    session:
      admission === "guest"
        ? null
        : {
            userId: admission === "moderator" ? MODERATOR.userId : MEMBER.userId,
            username: "fixture",
            avatar: null,
            member: true,
            moderator: admission === "moderator",
          },
    returnTo: null,
    joinResult: null,
    expiredWrite: null,
    restoredWrite: null,
  };
  const manifest = ROUTE_MANIFEST.map((r) =>
    r.path === "/admin/events/:key" && r.method === "GET" ? { ...r, enabled: true } : r,
  );
  return dispatchHookRequest(
    { request, url, route: { id: "/admin/events/[key]" } },
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
          const data = await kit.load({
            parent: () => kit.layout({ locals, url, setHeaders }),
            params: { key },
            url,
            setHeaders,
          });
          return new Response(kit.html(data), {
            headers: { ...headers, "content-type": "text/html; charset=UTF-8" },
          });
        } catch (error) {
          // SvelteKit's resolve converts layout redirects/HttpErrors to responses.
          // Never disguise a fixture or application exception as a valid denial.
          const failure = error as { status?: number; location?: string };
          if (failure.status === 302 && failure.location)
            return new Response(null, {
              status: 302,
              headers: { ...headers, location: failure.location },
            });
          if (failure.status === 403 || failure.status === 503)
            return new Response("Admin unavailable", { status: failure.status, headers });
          throw error;
        }
      },
    },
  );
}

export function rosterHtml(html: string) {
  const section = html.match(/<section\b[^>]*\bid="rsvp-roster"[\s\S]*?<\/section>/)?.[0];
  if (!section) throw new Error("real route did not render the RSVP roster");
  // Strip Svelte hydration comments by walking comment tokens: a comment
  // ends at the first `-->`. No regex rewrite, so CodeQL
  // incomplete-multi-character-sanitization does not apply.
  let out = "";
  let index = 0;
  while (index < section.length) {
    const start = section.indexOf("<!--", index);
    if (start === -1) {
      out += section.slice(index);
      break;
    }
    out += section.slice(index, start);
    const end = section.indexOf("-->", start + 4);
    index = end === -1 ? section.length : end + 3;
  }
  return out;
}
export const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export function links(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    label: text(m[2]!),
    href: m[1]!.match(/\bhref="([^"]*)"/)?.[1]?.replaceAll("&amp;", "&") ?? "",
    rel: m[1]!.match(/\brel="([^"]*)"/)?.[1],
  }));
}
export function subjects(fixture: RosterFixture): string[] {
  const raw = fixture.audits[0]?.subject_user_ids;
  return typeof raw === "string" ? JSON.parse(raw) : ((raw as string[]) ?? []);
}
