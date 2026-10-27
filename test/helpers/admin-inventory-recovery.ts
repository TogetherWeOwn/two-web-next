// Shared acceptance transport: real Hono routes and real Kit loaders + Svelte SSR.
// Only the database binding/framework error constructor are replaced, never readers.
import { build } from "esbuild";
import { PgDialect } from "drizzle-orm/pg-core";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminApp } from "../../src/admin/routes";
import type { Db } from "../../src/db/index";
import { createMemorySessionStore } from "../../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./member-data";

export type Inventory = "events" | "featured";
export type Renderer = "Hono" | "Kit";
export const origin = "https://inventory.example.test";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binding = "__inventoryRecoveryAcceptanceBinding";
const at = new Date("2099-11-01T18:00:00Z");

export function inventoryRow(inventory: Inventory, id = 1) {
  const common = { id, title: `Inventory fixture ${id}`, createdAt: at, updatedAt: at };
  return inventory === "events"
    ? {
        ...common,
        eventKey: `inventory-fixture-${id}`,
        game: null,
        description: null,
        startsAt: at,
        endsAt: new Date("2099-11-01T20:00:00Z"),
        timezone: "UTC",
        location: "Fixture room",
        capacity: 8,
        status: "draft",
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
        syncRevision: 0,
        syncedRevision: 0,
        rsvpOpen: true,
        createdBy: null,
      }
    : {
        ...common,
        legacyId: null,
        body: "Fixture description",
        url: null,
        imageUrl: null,
        imageAlt: null,
        isPublished: true,
        position: id,
        startsAt: null,
        endsAt: null,
        createdBy: null,
      };
}

type RecordedQuery = { sql: string; params: unknown[] };

// Real Drizzle builders and the real keyed-read observer, over a fixture session.
// Prepared-query execution returns already-mapped fixture rows, just as the
// production session does. No SQL connection or production transport is opened.
export function inventoryDb(inventory: Inventory, rows: unknown[] = []) {
  const queries: RecordedQuery[] = [];
  const executions: string[] = [];
  const audits: RecordedQuery[] = [];
  const queues = inventory === "events" && rows.length ? [rows, []] : [rows];
  let transactions = 0;
  const dialect = new PgDialect();
  const session = {
    prepareQuery(query: RecordedQuery) {
      return {
        setToken() {
          return this;
        },
        execute: async () => {
          if (query.sql.includes("set_config") || query.sql.startsWith("SET LOCAL")) {
            executions.push(query.sql);
            return [];
          }
          if (query.sql.startsWith('insert into "member_data_access_logs"')) {
            audits.push(query);
            return [];
          }
          if (!query.sql.startsWith("select ")) throw new Error("Unexpected inventory mutation");
          const index = queries.length;
          queries.push(query);
          if (index >= queues.length) throw new Error("Unexpected additional inventory read");
          return queues[index];
        },
      };
    },
    execute(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
      return this.prepareQuery(dialect.sqlToQuery(query)).execute();
    },
    transaction: async (fn: (transaction: Db) => Promise<unknown>) => {
      transactions++;
      return fn(db);
    },
  };
  const db = new PostgresJsDatabase(dialect, session as never, undefined) as Db;
  return {
    db,
    queries,
    executions,
    audits,
    get transactions() {
      return transactions;
    },
  };
}

type KitEvent = {
  url: URL;
  parent: () => Promise<unknown>;
  setHeaders: (headers: Record<string, string>) => void;
};
type KitRuntime = Record<
  `${Inventory}Load`,
  (event: KitEvent) => Promise<Record<string, unknown>>
> &
  Record<`${Inventory}Render`, (data: Record<string, unknown>) => string>;
let compiled: Promise<KitRuntime> | undefined;

export function compileInventoryKit(): Promise<KitRuntime> {
  compiled ??= (async () => {
    const webRequire = createRequire(resolve(root, "web/package.json"));
    const { compile } = webRequire("svelte/compiler");
    const styles: string[] = [];
    const source = [
      'import { render } from "svelte/server";',
      ...(["events", "featured"] as const).flatMap((inventory) => [
        `export { load as ${inventory}Load } from "./web/src/routes/admin/${inventory}/+page.server.ts";`,
        `import ${inventory}Page from "./web/src/routes/admin/${inventory}/+page.svelte";`,
        `export function ${inventory}Render(data) { return render(${inventory}Page, { props: { data } }).body; }`,
      ]),
    ].join("\n");
    const result = await build({
      stdin: { contents: source, resolveDir: root, sourcefile: "inventory-acceptance-entry.ts" },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "warning",
      tsconfigRaw: { compilerOptions: {} },
      nodePaths: [resolve(root, "web/node_modules"), resolve(root, "node_modules")],
      alias: { "#lib": resolve(root, "web/src/lib"), $lib: resolve(root, "web/src/lib") },
      plugins: [
        {
          name: "inventory-recovery-acceptance",
          setup(plugin) {
            plugin.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
              path: "kit",
              namespace: "fixture",
            }));
            plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "env",
              namespace: "fixture",
            }));
            plugin.onResolve({ filter: /src\/admin\/db$/ }, () => ({
              path: "db",
              namespace: "fixture",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
              contents:
                path === "kit"
                  ? "export function error(status, message) { throw Object.assign(new Error(message), { status }); }"
                  : path === "env"
                    ? "export const env = {};"
                    : "export async function dbFor() { const b = globalThis.__inventoryRecoveryAcceptanceBinding; b.calls++; return b.db; }",
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
    const runtime = {
      ...(await import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`
      )),
    } as KitRuntime;
    for (const inventory of ["events", "featured"] as const) {
      const render = runtime[`${inventory}Render`];
      runtime[`${inventory}Render`] = (data) =>
        `<style>${styles.join("\n")}</style>${render(data)}`;
    }
    return runtime;
  })();
  return compiled;
}

export async function renderInventory(
  renderer: Renderer,
  inventory: Inventory,
  search = "",
  rows: unknown[] = [],
  admission: "moderator" | "member" | "guest" = "moderator",
) {
  const probe = inventoryDb(inventory, rows);
  const url = new URL(`/admin/${inventory}${search}`, origin);
  if (renderer === "Hono") {
    const store = createMemorySessionStore();
    const cookie =
      admission === "guest"
        ? ""
        : await cookieFor(store, admission === "member" ? MEMBER : MODERATOR);
    const app = new Hono().route("/admin", adminApp({ sessionStore: store, db: probe.db }));
    const response = await app.request(
      url.href,
      { headers: { cookie } },
      { ...env, APP_URL: origin, ADMIN_DB: probe.db },
    );
    return {
      html: await response.text(),
      status: response.status,
      headers: response.headers,
      probe,
      bindingCalls: 0,
    };
  }
  const runtime = await compileInventoryKit();
  const context = { db: probe.db, calls: 0 };
  Reflect.set(globalThis, binding, context);
  const headers = new Headers();
  try {
    const data = await runtime[`${inventory}Load`]({
      url,
      parent: async () => {
        if (admission !== "moderator")
          throw Object.assign(new Error("Admission refused"), {
            status: admission === "guest" ? 302 : 403,
          });
        return { actor: MODERATOR };
      },
      setHeaders: (values) => {
        for (const [name, value] of Object.entries(values)) headers.set(name, value);
      },
    });
    return {
      html: runtime[`${inventory}Render`](data),
      status: 200,
      headers,
      probe,
      bindingCalls: context.calls,
    };
  } catch (error) {
    if (!(error instanceof Error) || !("status" in error)) throw error;
    return { html: "", status: Number(error.status), headers, probe, bindingCalls: context.calls };
  } finally {
    Reflect.deleteProperty(globalThis, binding);
  }
}
