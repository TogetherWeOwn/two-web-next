// Acceptance transport: real routes/readers/validation and Svelte SSR. Only the
// database wire and request-local framework bindings are synthetic.
import { build } from "esbuild";
import { PgDialect } from "drizzle-orm/pg-core";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { adminApp } from "../../src/admin/routes";
import type { Db } from "../../src/db/index";
import { createMemorySessionStore } from "../../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./member-data";
import { inventoryRow } from "./admin-inventory-recovery";

export const recoveryOrigin = "https://recovery.example.test";
export const recoveryEvent = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binding = "__adminSafeRecoveryAcceptance";
export type RecoveryRenderer = "Hono" | "Kit";
type Query = { sql: string; params: unknown[] };

export function recoveryDb(rows: unknown[] = [], outage = false) {
  const reads: Query[] = [];
  const writes: Query[] = [];
  const audits: Query[] = [];
  const dialect = new PgDialect();
  const session = {
    prepareQuery(query: Query) {
      return {
        setToken() {
          return this;
        },
        execute: async () => {
          if (query.sql.includes("set_config") || query.sql.startsWith("SET LOCAL")) return [];
          if (query.sql.startsWith('insert into "member_data_access_logs"')) {
            audits.push(query);
            return [];
          }
          if (!query.sql.startsWith("select ")) {
            writes.push(query);
            throw new Error("Unexpected mutation in recovery fixture");
          }
          reads.push(query);
          if (outage)
            throw Object.assign(new Error("PRIVATE_DATABASE_EXCEPTION"), {
              name: "PostgresError",
              code: "08006",
            });
          if (/count\s*\(/i.test(query.sql)) throw new Error("Recovery must not add a count read");
          return rows;
        },
      };
    },
    execute(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
      return this.prepareQuery(dialect.sqlToQuery(query)).execute();
    },
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db),
  };
  const db = new PostgresJsDatabase(dialect, session as never, undefined) as Db;
  return { db, reads, writes, audits };
}

export function refusedEvent(overrides: Record<string, unknown> = {}) {
  return { ...inventoryRow("events"), eventKey: recoveryEvent, status: "cancelled", ...overrides };
}

export const activityRow = {
  id: 7,
  description: "Recorded fixture change <not markup>",
  subjectType: "Event",
  subjectId: recoveryEvent,
  causerId: "100000000000000111",
  event: "updated",
  createdAt: new Date("2026-10-01T12:00:00.000Z"),
};

export async function honoRecovery(
  path: string,
  probe = recoveryDb(),
  method = "GET",
  admission: "moderator" | "member" | "guest" = "moderator",
) {
  const store = createMemorySessionStore();
  const cookie =
    admission === "guest"
      ? ""
      : await cookieFor(store, admission === "member" ? MEMBER : MODERATOR);
  const app = new Hono().route("/admin", adminApp({ sessionStore: store, db: probe.db }));
  const response = await app.request(
    new URL(path, recoveryOrigin).href,
    {
      method,
      headers: {
        cookie,
        origin: recoveryOrigin,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      },
      ...(method === "POST" ? { body: "" } : {}),
    },
    { ...env, APP_URL: recoveryOrigin, ADMIN_DB: probe.db },
  );
  return { html: await response.text(), status: response.status, headers: response.headers, probe };
}

type KitEvent = {
  url: URL;
  parent: () => Promise<unknown>;
  setHeaders: (headers: Record<string, string>) => void;
};
type KitRuntime = {
  load: (event: KitEvent) => Promise<Record<string, unknown>>;
  renderPage: (data: Record<string, unknown>) => string;
  css: string;
};
let compiled: Promise<KitRuntime> | undefined;
export function compileRecoveryKit(): Promise<KitRuntime> {
  compiled ??= (async () => {
    const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
    const { compile } = webRequire("svelte/compiler");
    const styles: string[] = [];
    const result = await build({
      stdin: {
        contents: `
import { render } from "svelte/server";
import Page from "./web/src/routes/admin/activity-log/+page.svelte";
export { load } from "./web/src/routes/admin/activity-log/+page.server.ts";
export function renderPage(data) { return render(Page, { props: { data } }).body; }
`,
        resolveDir: root,
        loader: "js",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      tsconfigRaw: { compilerOptions: {} },
      nodePaths: [resolve(root, "web/node_modules"), resolve(root, "node_modules")],
      alias: { "#lib": resolve(root, "web/src/lib"), $lib: resolve(root, "web/src/lib") },
      plugins: [
        {
          name: "safe-recovery-fixture",
          setup(plugin) {
            plugin.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
              path: "kit",
              namespace: "fixture",
            }));
            plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "env",
              namespace: "fixture",
            }));
            plugin.onResolve({ filter: /(?:^|\/)db(?:\.ts)?$/ }, (args) => {
              if (resolve(dirname(args.importer), args.path) === resolve(root, "src/admin/db"))
                return { path: "db", namespace: "fixture" };
            });
            plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
              contents:
                path === "kit"
                  ? "export function error(status, message) { throw Object.assign(new Error(message), { status }); }"
                  : path === "env"
                    ? "export const env = {};"
                    : `export async function dbFor() { return globalThis.${binding}.db; }`,
              loader: "js",
            }));
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
              const result = compile(readFileSync(path, "utf8"), {
                generate: "server",
                dev: false,
                filename: path,
              });
              if (result.css?.code) styles.push(result.css.code);
              return { contents: result.js.code, loader: "js", resolveDir: dirname(path) };
            });
          },
        },
      ],
    });
    const runtime = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`
    );
    return { ...runtime, css: styles.join("\n") } as KitRuntime;
  })();
  return compiled;
}

export async function activityRecovery(
  renderer: RecoveryRenderer,
  search = "",
  rows: unknown[] = [],
  outage = false,
) {
  const probe = recoveryDb(rows, outage);
  const path = `/admin/activity-log${search}`;
  if (renderer === "Hono") return honoRecovery(path, probe);
  const runtime = await compileRecoveryKit();
  const headers = new Headers();
  Reflect.set(globalThis, binding, probe);
  try {
    const data = await runtime.load({
      url: new URL(path, recoveryOrigin),
      parent: async () => ({ actor: MODERATOR }),
      setHeaders: (values) => {
        for (const [k, v] of Object.entries(values)) headers.set(k, v);
      },
    });
    return {
      html: `<style>${runtime.css}</style>${runtime.renderPage(data)}`,
      status: 200,
      headers,
      probe,
    };
  } catch (error) {
    if (!(error instanceof Error) || !("status" in error)) throw error;
    return { html: "", status: Number(error.status), headers, probe };
  } finally {
    Reflect.deleteProperty(globalThis, binding);
  }
}
