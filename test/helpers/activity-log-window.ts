// Acceptance fixture: real routes, Kit loader/layout/SSR, SQL builders and read
// boundaries. Only the SQL transport, session store and Workers env are injected.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { Hono } from "hono";
import { adminApp } from "../../src/admin/routes";
import type { Db } from "../../src/db/index";
import { createMemorySessionStore } from "../../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./member-data";

export const WINDOW_ORIGIN = "https://activity.example.test";
export const WINDOW_NOW = "2026-11-01T07:30:00.000Z";
export type ActivityTwin = "Hono" | "Kit";
export type WindowActor = "moderator" | "member" | "guest";
export type WindowReply = { status: number; html: string; headers: Headers; data?: unknown };
type Statement = { sql: string; params: unknown[] };
export type WindowRow = {
  id: number;
  description: string;
  subject_type: string | null;
  subject_id: string | null;
  causer_id: string | null;
  event: string;
  created_at: string;
};
export const windowRows = (count = 51): WindowRow[] =>
  Array.from({ length: count }, (_, i) => ({
    id: count - i,
    description: `Recorded fixture change ${count - i}`,
    subject_type: "Event",
    subject_id: `fixture-${count - i}`,
    causer_id: String(100000000000001000n + BigInt(i)),
    event: "updated",
    created_at: WINDOW_NOW,
  }));

type KitWindow = {
  request(args: { env: unknown; path: string; actor: WindowActor }): Promise<WindowReply>;
};

export async function compileActivityWindowKit(): Promise<KitWindow> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const { outputFiles } = await build({
    stdin: {
      contents: `
import { render } from "svelte/server";
import Page from "./web/src/routes/admin/activity-log/+page.svelte";
import { load } from "./web/src/routes/admin/activity-log/+page.server.ts";
import { load as layout } from "./web/src/routes/admin/+layout.server.ts";
import { memberReadResponse } from "./src/member-reads.ts";
import { recordAccess } from "./src/admin/store-access.ts";
import { setEnv } from "cloudflare:workers";
export async function request({ env, path, actor }) {
  setEnv(env);
  const headers = new Headers({ "content-type": "text/html" });
  const setHeaders = (values) => { for (const [key, value] of Object.entries(values)) headers.set(key, value); };
  const url = new URL(path, ${JSON.stringify(WINDOW_ORIGIN)});
  const locals = {
    status: actor === "guest" ? "guest" : "authenticated",
    session: actor === "guest" ? undefined : {
      userId: ${JSON.stringify(MODERATOR.userId)}, username: "Fixture moderator",
      member: true, moderator: actor === "moderator"
    }
  };
  let data;
  const response = await memberReadResponse(
    { method: "GET", route: "/admin/activity-log" },
    { viewer: actor === "guest" ? null : ${JSON.stringify(MODERATOR.userId)}, resource: "activity_log", action: "list", route: "admin.activity-log.index" },
    (entry) => recordAccess(env.ADMIN_DB, entry),
    async () => {
      try {
        data = await load({ url, setHeaders, parent: () => layout({ locals, url, setHeaders }) });
        const { head, body } = render(Page, { props: { data } });
        return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + head + '</head><body>' + body + '</body></html>', { headers });
      } catch (error) {
        if (![302, 403, 503].includes(error?.status)) throw error;
        if (error.location) headers.set("location", error.location);
        return new Response("", { status: error.status, headers });
      }
    }
  );
  return { status: response.status, html: await response.text(), headers: response.headers, data };
}`,
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
      js: `import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(${JSON.stringify(join(root, "package.json"))});`,
    },
    plugins: [
      {
        name: "activity-window-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "env",
            namespace: "activity-window",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "activity-window" }, () => ({
            contents:
              "let current; export const setEnv = (value) => { current = value; }; export const env = new Proxy({}, { get: (_, key) => Reflect.get(current, key) });",
            loader: "js",
          }));
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
            const { js } = compile(readFileSync(path, "utf8"), {
              generate: "server",
              dev: false,
              filename: path,
            });
            return { contents: js.code, loader: "js", resolveDir: dirname(path) };
          });
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
  );
}

export function activityWindowHarness(
  kit: KitWindow,
  options: { rows?: WindowRow[]; failAudit?: boolean; unavailable?: boolean } = {},
) {
  const statements: Statement[] = [];
  const audits: {
    subjectUserIds: string[];
    resource: string;
    route: string;
    viewerDiscordId: string;
  }[] = [];
  const rows = options.rows ?? windowRows();
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params: [...params] });
    if (sql.includes('insert into "member_data_access_logs"')) {
      if (options.failAudit) throw new Error("Fixture audit refused");
      const columns = sql
        .match(/\(([^)]+)\) values/)![1]!
        .split(",")
        .map((c) => c.trim().replaceAll('"', ""));
      // Drizzle emits DEFAULTs for generated columns. Match placeholders to
      // columns instead of assuming INSERT positional offsets.
      const values = sql
        .match(/values \(([^)]+)\)/)![1]!
        .split(",")
        .map((v) => v.trim());
      const entry = Object.fromEntries(
        columns.map((c, i) => [
          c,
          values[i]!.startsWith("$") ? params[Number(values[i]!.slice(1)) - 1] : undefined,
        ]),
      );
      audits.push({
        subjectUserIds: JSON.parse(String(entry.subject_user_ids)),
        resource: String(entry.resource),
        route: String(entry.route),
        viewerDiscordId: String(entry.viewer_discord_id),
      });
    }
    if (sql.includes('from "activity_log"')) {
      const columns = sql
        .slice(0, sql.indexOf(" from "))
        .replace(/^select /, "")
        .split(",")
        .map((c) => c.trim().replaceAll('"', "").split(".").at(-1)!);
      const limit = sql.match(/limit \$(\d+)/);
      const offset = sql.match(/offset \$(\d+)/);
      const start = offset ? Number(params[Number(offset[1]) - 1]) : 0;
      const end = start + (limit ? Number(params[Number(limit[1]) - 1]) : rows.length);
      return {
        rows: rows.slice(start, end).map((row) => columns.map((c) => row[c as keyof WindowRow])),
      };
    }
    return { rows: [] };
  });
  // pg-proxy has no transaction transport. Real transaction/SQL semantics are
  // covered separately against the disposable PostgreSQL fixture.
  Object.assign(Reflect.get(db, "session"), {
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  });
  const sessions = createMemorySessionStore();
  const bindings = {
    ...env,
    APP_URL: WINDOW_ORIGIN,
    ...(options.unavailable ? {} : { ADMIN_DB: db }),
  };
  const app = new Hono().route(
    "/admin",
    adminApp({ sessionStore: sessions, db: db as unknown as Db }),
  );
  return {
    statements,
    audits,
    async request(
      twin: ActivityTwin,
      path: string,
      actor: WindowActor = "moderator",
    ): Promise<WindowReply> {
      if (twin === "Kit") return kit.request({ env: bindings, path, actor });
      const cookie =
        actor === "guest"
          ? undefined
          : await cookieFor(sessions, actor === "member" ? MEMBER : MODERATOR);
      const response = await app.request(
        path,
        { headers: { ...(cookie ? { cookie } : {}), accept: "text/html" } },
        bindings,
      );
      return { status: response.status, html: await response.text(), headers: response.headers };
    },
  };
}
