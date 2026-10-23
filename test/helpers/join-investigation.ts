// Test Author owned. Script only the SQL transport; use the real route, reads,
// normalization, Kit loads and SSR pages. No database or external requests.
import { build } from "esbuild";
import { drizzle } from "drizzle-orm/pg-proxy";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adminApp } from "../../src/admin/routes";
import type { JoinAttemptRow } from "../../src/admin/reads";
import type { Db } from "../../src/db/index";
import { createMemorySessionStore } from "../../src/sessions";
import { cookieFor, env, MODERATOR } from "./member-data";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const listPath = "/admin/join-attempts";
export const twins = ["Hono", "Kit"] as const;
export type Twin = (typeof twins)[number];
export const recorded: JoinAttemptRow = {
  id: 7,
  outcome: "error",
  source: "join",
  requestId: "request:fixture-7",
  discordId: null,
  createdAt: new Date("2026-10-23T12:00:00.000Z"),
};
export type Statement = { sql: string; params: unknown[] };

export function scriptedDb(rows: JoinAttemptRow[], failAudit = false) {
  const statements: Statement[] = [];
  const proxy = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes('from "join_attempts"')) {
      // Both shared reads select the same six-column projection. Do not emulate
      // filtering/paging here: SQL predicates are checked separately, and live
      // retention/exact-match proofs stay in the existing disposable-DB suites.
      return {
        rows: rows.map((r) => [
          r.id,
          r.outcome,
          r.source,
          r.requestId,
          r.discordId,
          r.createdAt.toISOString(),
        ]),
      };
    }
    if (sql.startsWith('insert into "member_data_access_logs"')) {
      if (failAudit) throw new Error("fixture audit unavailable");
      return { rows: [] };
    }
    if (sql.startsWith("select set_config(")) return { rows: [] };
    throw new Error(`Unexpected investigation fixture SQL: ${sql}`);
  });
  const db = proxy as unknown as Db;
  // Match the existing pg-proxy seam: the observer clones the session, so a
  // db.transaction-only shim would accidentally attempt a real transaction.
  const session = (proxy as unknown as { session: { transaction: unknown } }).session;
  session.transaction = async (fn: (tx: Db) => Promise<unknown>) => fn(db);
  return { db, statements };
}

export async function compileInvestigationKit() {
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "join-investigation-"),
  );
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const outfile = join(scratch, "join-investigation.mjs");
  try {
    await build({
      stdin: {
        contents: `
          import { render } from 'svelte/server';
          import List from './web/src/routes/admin/join-attempts/+page.svelte';
          import Detail from './web/src/routes/admin/join-attempts/[id]/+page.svelte';
          import { load as listLoad } from './web/src/routes/admin/join-attempts/+page.server.ts';
          import { load as detailLoad } from './web/src/routes/admin/join-attempts/[id]/+page.server.ts';
          import { configure } from 'fixture:db';
          export async function document(path, db) {
            configure(db);
            const url = new URL(path, 'https://example.test');
            const detail = url.pathname !== '/admin/join-attempts';
            const headers = {};
            const event = {
              url,
              params: {id: url.pathname.split('/').pop()},
              parent: async () => ({actor: {id: '100000000000000103', username: 'fixture'}}),
              setHeaders: (values) => Object.assign(headers, values),
            };
            const data = await (detail ? detailLoad : listLoad)(event);
            const result = render(detail ? Detail : List, {props: {data}});
            return {html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + result.head + '</head><body>' + result.body + '</body></html>', headers};
          }
        `,
        resolveDir: root,
        sourcefile: "join-investigation-fixture.mjs",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      absWorkingDir: root,
      tsconfigRaw: { compilerOptions: {} },
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      logLevel: "silent",
      plugins: [
        {
          name: "join-investigation-fixtures",
          setup(plugin) {
            plugin.onResolve(
              { filter: /^(fixture:db|cloudflare:workers|@sveltejs\/kit)$/ },
              ({ path }) => ({
                path,
                namespace: "investigation-fixture",
              }),
            );
            plugin.onResolve({ filter: /src\/admin\/db$/ }, () => ({
              path: "fixture:db",
              namespace: "investigation-fixture",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "investigation-fixture" }, ({ path }) => ({
              loader: "js",
              contents:
                path === "fixture:db"
                  ? "let db; export const configure=(value)=>{db=value}; export async function dbFor(){return db}"
                  : path === "cloudflare:workers"
                    ? "export const env = {}"
                    : "export function error(status,message){throw Object.assign(new Error(message),{status})}",
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
    const module = await import(pathToFileURL(outfile).href);
    return {
      document: module.document as (
        path: string,
        db: Db,
      ) => Promise<{ html: string; headers: Record<string, string> }>,
      dispose: () => rmSync(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

export async function investigationDocument(
  kit: Awaited<ReturnType<typeof compileInvestigationKit>>,
  twin: Twin,
  path: string,
  rows: JoinAttemptRow[] = [recorded],
  options: { failAudit?: boolean; actor?: "moderator" | "member" | "guest" } = {},
) {
  const { db, statements } = scriptedDb(rows, options.failAudit);
  if (twin === "Kit") {
    const result = await kit.document(path, db);
    return { ...result, status: 200, statements };
  }
  const sessions = createMemorySessionStore();
  const actor = options.actor ?? "moderator";
  const cookie =
    actor === "guest"
      ? ""
      : await cookieFor(sessions, { ...MODERATOR, moderator: actor === "moderator" });
  const response = await adminApp({ sessionStore: sessions, db }).request(
    path.replace(/^\/admin/, ""),
    { headers: { cookie } },
    { ...env, ADMIN_DB: db },
  );
  return {
    html: await response.text(),
    headers: Object.fromEntries(response.headers),
    status: response.status,
    statements,
  };
}

// Read attributes from emitted HTML, not source. This is deliberately independent
// of the product URL builder, and tolerates both Hono and Svelte escaping.
export const decode = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
export function links(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].flatMap((m) => {
    const href = /\bhref="([^"]*)"/.exec(m[1]!);
    return href ? [{ href: decode(href[1]!), text: plain(m[2]!) }] : [];
  });
}
export function plain(html: string) {
  return decode(html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
export function detailHref(html: string) {
  return links(html).find((a) => /^\/admin\/join-attempts\/7(?:\?|$)/.test(a.href))?.href ?? "";
}
export function backHref(html: string) {
  return (
    links(html).find(
      (a) => /back|results|return/i.test(a.text) && /^\/admin\/join-attempts(?:\?|$)/.test(a.href),
    )?.href ?? ""
  );
}
export function listState(href: string) {
  const url = new URL(href, "https://example.test");
  return {
    origin: url.origin,
    path: url.pathname,
    outcome: url.searchParams.get("outcome") ?? "",
    q: url.searchParams.get("q") ?? "",
    page: url.searchParams.get("page") ?? "1",
  };
}
