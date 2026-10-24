// Acceptance-owned: real archive and detail loaders/renderers, synthetic data only.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { serializeSigned } from "hono/utils/cookie";
import type { AccessEntry } from "../../src/access-log";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import type { PublicEvent } from "../../src/events/reads";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";
import app from "../app";
import {
  ARCHIVE_ORIGIN,
  archiveReadFixture,
  archiveRow,
  compileArchiveKit,
  requestArchive,
  type ArchiveTwin,
} from "./past-archive-search-acceptance";

export const QUERY = 'Raid 🌌 "night" & <crew>';
export const RAW_QUERY = ` \0${QUERY}  `;
export const VIEWER = "100000000000000001";
export const eventKey = (id: number) => `01ARZ3NDEKTSV4RRFFQ69G${String(id).padStart(4, "0")}`;
export const DETAIL_PATH = `/e/${eventKey(5)}`;
export const attendeeId = (id: number) => `400000000000${String(id).padStart(6, "0")}`;
const SECRET = "test-session-secret-at-least-32-bytes-long";
const rows = () =>
  Array.from({ length: 25 }, (_, i) =>
    archiveRow(25 - i, {
      eventKey: eventKey(25 - i),
      title: `${QUERY} ${25 - i}`,
      goingCount: 205,
      goingOccupancy: 205,
    }),
  );

export type Viewer = "guest" | "member" | "outsider" | "moderator";
const sessionFor = (viewer: Viewer) =>
  viewer === "guest"
    ? null
    : {
        userId: VIEWER,
        username: "archive-member",
        avatar: null,
        member: viewer !== "outsider",
        moderator: viewer === "moderator",
      };

export function returnFixture() {
  const archive = archiveReadFixture();
  archive.replaceRows(rows());
  let event: PublicEvent | null = rows().find((r) => r.id === 5)!;
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const statements: { sql: string; params: unknown[] }[] = [];
  const attendees = Array.from({ length: 205 }, (_, i) => [attendeeId(i), `return-attendee-${i}`]);
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.startsWith('select "users"."id", "users"."username"')) {
      const offset = sql.includes(" offset ") ? Number(params.at(-1)) : 0;
      const limit = Number(params.at(sql.includes(" offset ") ? -2 : -1));
      return { rows: attendees.slice(offset, offset + limit) };
    }
    if (sql.includes('from "rsvps"'))
      return { rows: sql.includes("count(*)") && event ? [[event.id, 205]] : [] };
    if (sql.includes('"event_key" =')) {
      return {
        rows:
          event && params.includes(event.eventKey)
            ? [
                columns.map((key) =>
                  event![key] instanceof Date ? (event![key] as Date).toISOString() : event![key],
                ),
              ]
            : [],
      };
    }
    // Neighbor/suggestion projections are empty, not full event-shaped rows.
    return { rows: [] };
  }) as unknown as Db;
  const sessions = createMemorySessionStore();
  const env = {
    ...archive.env,
    ADMIN_DB: db,
    SESSION_STORE: sessions,
    SESSION_SECRET: SECRET,
  } as unknown as Env;
  return {
    env,
    statements,
    archiveEnv: archive.env,
    setArchiveQuery(query: string) {
      archive.replaceRows(rows().map((row) => ({ ...row, title: `${query} ${row.id}` })));
    },
    setEvent(over: Partial<PublicEvent> | null) {
      event = over === null ? null : { ...rows().find((r) => r.id === 5)!, ...over };
    },
    async hono(url: URL, viewer: Viewer) {
      const session = sessionFor(viewer);
      const headers = new Headers();
      if (session) {
        const token = newSessionToken();
        await sessions.create({
          ...session,
          tokenHash: await hashToken(token),
          expiresAt: new Date(Date.now() + 3600_000),
        });
        headers.set(
          "cookie",
          (
            await serializeSigned("__Host-two_session", token, SECRET, {
              path: "/",
              secure: true,
              httpOnly: true,
              sameSite: "Lax",
            })
          ).split(";")[0]!,
        );
      }
      return app.request(new Request(url, { headers }), {}, env);
    },
  };
}

// Bind only the Workers env and hook locals. URL parsing, production store,
// real +page.server load, Svelte page and member-read boundary stay executable.
async function compileDetailKit() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const requireWeb = createRequire(join(root, "web/package.json"));
  const { compile } = requireWeb("svelte/compiler") as {
    compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
  };
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "return-acceptance-"),
  );
  const outfile = join(scratch, "detail.mjs");
  await build({
    stdin: {
      contents: `
        import {render} from "svelte/server";
        import Page from ${JSON.stringify(join(root, "web/src/routes/e/[key]/+page.svelte"))};
        import {load} from ${JSON.stringify(join(root, "web/src/routes/e/[key]/+page.server.ts"))};
        import {memberReadResponse} from ${JSON.stringify(join(root, "src/member-reads.ts"))};
        import {bind} from "acceptance:env";
        export async function request(url, env, session, sink) {
          bind(env);
          const headers = new Headers({"content-type":"text/html"});
          return memberReadResponse({method:"GET",route:"events.page"},
            {resource:"member",action:"list",route:"events.page",viewer:session?.userId ?? null}, sink,
            async () => {
              try {
                const data = await load({params:{key:url.pathname.split("/").at(-1)},url,
                  request:new Request(url),locals:{status:session?"authenticated":"guest",session,joinResult:null},
                  cookies:{delete(){throw new Error("No flash cookie in fixture");}},
                  setHeaders(next){for(const [k,v] of Object.entries(next)) headers.set(k,v);}});
                const {head,body}=render(Page,{props:{data}});
                return new Response("<head>"+head+"</head><body>"+body+"</body>",{headers});
              } catch(error) {
                if (!error.status) throw error;
                if (error.location) headers.set("location",error.location);
                return new Response(error.body?.message ?? "",{status:error.status,headers});
              }
            });
        }`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "archive-return-detail-bindings",
        setup(plugin) {
          plugin.onResolve({ filter: /^(cloudflare:workers|acceptance:env)$/ }, () => ({
            path: "env",
            namespace: "acceptance",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "acceptance" }, () => ({
            contents: "export let env; export function bind(value){env=value;}",
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
  const kit = (await import(pathToFileURL(outfile).href)) as {
    request: (
      url: URL,
      env: Env,
      session: ReturnType<typeof sessionFor>,
      sink: (entry: AccessEntry) => Promise<boolean>,
    ) => Promise<Response>;
  };
  return { ...kit, dispose: () => rmSync(scratch, { recursive: true, force: true }) };
}

export async function compileReturnTwins() {
  const archive = await compileArchiveKit();
  const detail = await compileDetailKit();
  return {
    archive(
      twin: ArchiveTwin,
      path: string,
      fixture: ReturnType<typeof returnFixture>,
      enhanced = false,
    ) {
      return requestArchive(
        twin,
        path,
        fixture.archiveEnv,
        archive,
        enhanced ? { headers: { accept: "text/html" } } : undefined,
      );
    },
    detail(
      twin: ArchiveTwin,
      url: URL,
      fixture: ReturnType<typeof returnFixture>,
      viewer: Viewer = "guest",
      sink: (entry: AccessEntry) => Promise<boolean> = async () => true,
    ) {
      return twin === "Hono"
        ? fixture.hono(url, viewer)
        : detail.request(url, fixture.env, sessionFor(viewer), sink);
    },
    dispose() {
      archive.dispose();
      detail.dispose();
    },
  };
}

export { ARCHIVE_ORIGIN };
