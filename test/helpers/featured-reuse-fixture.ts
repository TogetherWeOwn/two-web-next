import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { adminApp } from "../../src/admin/routes";
import type { FeaturedEditRow } from "../../src/admin/store-featured";
import { featuredContents } from "../../src/db/admin-schema";
import type { Db } from "../../src/db";
import { isDatabaseUnavailable } from "../../src/db/errors";
import { createMemorySessionStore, type Sql } from "../../src/sessions";
import { sameOrigin } from "../../src/same-origin";
import { cookieFor, env as sessionEnv, MEMBER, MODERATOR } from "./member-data";

export const renderers = ["hono", "kit"] as const;
export type Renderer = (typeof renderers)[number];
export const editorial = {
  title: "Friday tabletop games",
  body: "Bring a friend & choose a game.",
  url: "https://example.org/games?from=featured&week=2",
  image_url: "https://cdn.discordapp.com/attachments/game-night.png",
  image_alt: "Friends choosing a tabletop game",
};

export function sourceRow(state: "live" | "expired" | "unpublished" = "live"): FeaturedEditRow {
  return {
    id: 41,
    legacyId: "880041",
    title: editorial.title,
    body: editorial.body,
    url: editorial.url,
    imageUrl: editorial.image_url,
    imageAlt: editorial.image_alt,
    isPublished: state !== "unpublished",
    position: 19,
    startsAt: new Date("2001-01-01T12:00:00Z"),
    endsAt: new Date(state === "expired" ? "2001-01-03T12:00:00Z" : "2199-01-01T12:00:00Z"),
    startsAtText: "2001-01-01 12:00:00.123456",
    endsAtText: state === "expired" ? "2001-01-03 12:00:00.654321" : "2199-01-01 12:00:00.654321",
    createdBy: "100000000000000141",
    createdAt: new Date("2000-01-01T00:00:00Z"),
    updatedAt: new Date("2001-01-01T00:00:00Z"),
  };
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
function children(node: Node): Node[] {
  return "childNodes" in node ? node.childNodes : [];
}
function text(node: Node): string {
  return node.nodeName === "#text"
    ? (node as DefaultTreeAdapterMap["textNode"]).value
    : children(node).map(text).join("");
}
function find(node: Node, predicate: (element: Element) => boolean): Element | null {
  for (const child of children(node)) {
    if ("tagName" in child && predicate(child)) return child;
    const nested = find(child, predicate);
    if (nested) return nested;
  }
  return null;
}

// Small parse5-backed view, not a DOM imitation used by production code. It
// decodes native form values/attributes without brittle HTML/source matching.
class HtmlView {
  constructor(
    readonly node: Node,
    readonly document: Node = node,
  ) {}
  get textContent() {
    return text(this.node);
  }
  get ownerDocument() {
    return new HtmlView(this.document);
  }
  getAttribute(name: string) {
    return "attrs" in this.node
      ? (this.node.attrs.find((a) => a.name === name)?.value ?? null)
      : null;
  }
  hasAttribute(name: string) {
    return this.getAttribute(name) !== null;
  }
  getElementById(id: string) {
    return this.select((e) => e.attrs.some((a) => a.name === "id" && a.value === id));
  }
  select(predicate: (element: Element) => boolean): HtmlView | null {
    const node = find(this.node, predicate);
    return node ? new HtmlView(node, this.document) : null;
  }
  querySelector(selector: string): HtmlView | null {
    const selectors = selector.split(",").map((s) => s.trim());
    return this.select((e) =>
      selectors.some((s) => {
        const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(s);
        return attr
          ? e.attrs.some(
              (a) => a.name === attr[1] && (attr[2] === undefined || a.value === attr[2]),
            )
          : e.tagName === s;
      }),
    );
  }
}
export function newForm(html: string) {
  const document = new HtmlView(parse(html));
  const form = document.select(
    (e) =>
      e.tagName === "form" &&
      e.attrs.some((a) => a.name === "action" && a.value.split("?")[0] === "/admin/featured"),
  );
  if (!form) throw new Error("FR-FORM missing native create form: preserve POST /admin/featured");
  return form;
}
export function formValues(form: HtmlView): Record<string, string> {
  const out: Record<string, string> = {};
  function visit(node: Node) {
    if ("tagName" in node) {
      const view = new HtmlView(node);
      const name = view.getAttribute("name");
      if (
        name &&
        ["input", "textarea", "select"].includes(node.tagName) &&
        !view.hasAttribute("disabled")
      ) {
        const kind = view.getAttribute("type");
        if (kind !== "checkbox" || view.hasAttribute("checked"))
          out[name] =
            node.tagName === "textarea"
              ? view.textContent
              : (view.getAttribute("value") ?? (kind === "checkbox" ? "on" : ""));
      }
    }
    for (const child of children(node)) visit(child);
  }
  visit(form.node);
  return out;
}
export function reuseHref(html: string): string | null {
  const link = new HtmlView(parse(html)).select(
    (e) => e.tagName === "a" && /reuse\s+as\s+(?:a\s+)?new\s+slot/i.test(text(e)),
  );
  return link?.getAttribute("href") ?? null;
}

type Statement = { sql: string; params: unknown[]; table?: string };
function splitSqlList(value: string): string[] {
  let depth = 0;
  let quote = "";
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote) {
      if (c === quote) {
        if (value[i + 1] === quote) i++;
        else quote = "";
      }
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...parts, value.slice(start).trim()];
}
function projectedRow(sql: string, row: FeaturedEditRow) {
  const projection = sql.includes(" returning ")
    ? sql.split(" returning ")[1]!
    : sql.slice(7, sql.indexOf(' from "featured_contents"'));
  const columns = Object.entries(getTableColumns(featuredContents));
  return splitSqlList(projection).map((expression) => {
    if (/\bcase\b/i.test(expression))
      return expression.includes('"starts_at"') ? row.startsAtText : row.endsAtText;
    const name = /"([^"]+)"\s*$/.exec(expression)?.[1];
    const key = columns.find(([, column]) => column.name === name)?.[0];
    if (!key) throw new Error(`FR-FIXTURE unsupported projection: ${expression}`);
    const value = row[key as keyof FeaturedEditRow];
    return value instanceof Date ? value.toISOString() : value;
  });
}
function insertedValues(sql: string, params: unknown[]) {
  const match = /insert into "[^"]+" \((.*?)\) values \((.*?)\)(?: returning|$)/s.exec(sql);
  if (!match) throw new Error(`FR-FIXTURE unsupported insert: ${sql}`);
  const columns = splitSqlList(match[1]!).map((s) => s.replaceAll('"', ""));
  const values = splitSqlList(match[2]!);
  return Object.fromEntries(
    columns.flatMap((column, i) => {
      const expression = values[i]!;
      if (expression === "default") return [];
      const n = /^\$(\d+)(?:::\w+)?$/.exec(expression)?.[1];
      if (!n) throw new Error(`FR-FIXTURE unsupported value: ${expression}`);
      const value = params[Number(n) - 1];
      return [
        [column, column === "properties" && typeof value === "string" ? JSON.parse(value) : value],
      ];
    }),
  );
}

type KitRuntime = {
  newLoad: (event: unknown) => Promise<unknown>;
  editLoad: (event: unknown) => Promise<unknown>;
  renderNew: (data: unknown) => string;
  renderEdit: (data: unknown) => string;
};
let kitRuntime: Promise<KitRuntime> | undefined;
function kit() {
  return (kitRuntime ??= (async () => {
    const root = process.cwd();
    const webRequire = createRequire(path.join(root, "web/package.json"));
    const { compile } = webRequire("svelte/compiler");
    const built = await build({
      stdin: {
        contents: `import {render} from 'svelte/server';
        export {load as newLoad} from './web/src/routes/admin/featured/new/+page.server.ts';
        export {load as editLoad} from './web/src/routes/admin/featured/[id]/+page.server.ts';
        import New from './web/src/routes/admin/featured/new/+page.svelte';
        import Edit from './web/src/routes/admin/featured/[id]/+page.svelte';
        export const renderNew = data => { const r=render(New,{props:{data}}); return r.head+r.body; };
        export const renderEdit = data => { const r=render(Edit,{props:{data}}); return r.head+r.body; };`,
        resolveDir: root,
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      jsx: "automatic",
      jsxImportSource: "hono/jsx",
      tsconfigRaw: {},
      nodePaths: [path.join(root, "web/node_modules"), path.join(root, "node_modules")],
      alias: { "#lib": path.join(root, "web/src/lib") },
      plugins: [
        {
          name: "featured-reuse-real-kit",
          setup(b) {
            b.onResolve({ filter: /^cloudflare:workers$|^@sveltejs\/kit$/ }, ({ path: name }) => ({
              path: name,
              namespace: "reuse-runtime",
            }));
            b.onLoad({ filter: /.*/, namespace: "reuse-runtime" }, ({ path: name }) => ({
              contents:
                name === "cloudflare:workers"
                  ? `export const env = new Proxy({}, {get: (_, key) => globalThis.__featuredReuseEnv[key]});`
                  : `export function error(status,message){throw Object.assign(new Error(message),{status});}
             export function redirect(status,location){throw Object.assign(new Error('Redirect'),{status,location});}`,
              loader: "js",
            }));
            b.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => ({
              contents: compile(await readFile(filename, "utf8"), { filename, generate: "server" })
                .js.code,
              loader: "js",
              resolveDir: path.dirname(filename),
            }));
          },
        },
      ],
    });
    return (await import(
      `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`
    )) as KitRuntime;
  })());
}

export async function fixture(initial = sourceRow(), appUrl = "https://example.org") {
  let source: FeaturedEditRow | null = structuredClone(initial);
  let unavailable = false;
  let created: FeaturedEditRow | null = null;
  let audit: Record<string, unknown> | null = null;
  const statements: Statement[] = [];
  const db = drizzle(async (sql, params) => {
    const table = /(?:from|into|update) "([^"]+)"/.exec(sql)?.[1];
    statements.push({ sql, params, table });
    if (/^select\b/i.test(sql) && table === "featured_contents") {
      if (unavailable)
        throw Object.assign(new Error("fixture source transport unavailable"), {
          code: "ECONNRESET",
        });
      const found =
        source && params.includes(source.id)
          ? source
          : created && params.includes(created.id)
            ? created
            : null;
      return { rows: found ? [projectedRow(sql, found)] : [] };
    }
    if (/^select set_config\(/.test(sql)) return { rows: [] };
    if (/^insert into "featured_contents"/.test(sql)) {
      const values = insertedValues(sql, params);
      const mapped = Object.fromEntries(
        Object.entries(getTableColumns(featuredContents)).flatMap(([key, column]) =>
          column.name in values ? [[key, values[column.name]]] : [],
        ),
      );
      created = {
        id: 9001,
        legacyId: null,
        title: "",
        body: null,
        url: null,
        imageUrl: null,
        imageAlt: null,
        isPublished: false,
        position: 0,
        startsAt: null,
        endsAt: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        startsAtText: null,
        endsAtText: null,
        ...mapped,
      } as FeaturedEditRow;
      return { rows: [projectedRow(sql, created)] };
    }
    if (/^insert into "activity_log"/.test(sql)) {
      audit = insertedValues(sql, params);
      return { rows: [] };
    }
    throw new Error(`FR-FIXTURE unexpected statement: ${sql}`);
  }) as unknown as Db;
  // The transport double records every real model statement; it does not
  // claim to prove PostgreSQL rollback, locks, defaults or query planning.
  (
    db as unknown as { transaction: (callback: (tx: Db) => Promise<unknown>) => Promise<unknown> }
  ).transaction = async (callback) => callback(db);
  const sessionStore = createMemorySessionStore();
  const cookie = await cookieFor(sessionStore, MODERATOR);
  const memberCookie = await cookieFor(sessionStore, MEMBER);
  let writeLimited = false;
  let throttleCalls = 0;
  const throttleSql = Object.assign(
    async (strings: TemplateStringsArray) => {
      throttleCalls++;
      return strings.join("?").includes("count(*)") ? [{ n: writeLimited ? 31 : 0, wait: 21 }] : [];
    },
    { unsafe: async () => [] },
  ) as unknown as Sql;
  Object.assign(throttleSql, {
    begin: async (run: (tx: Sql) => Promise<unknown>) => run(throttleSql),
  });
  const env = {
    ...sessionEnv,
    APP_URL: appUrl,
    ADMIN_DB: db,
    THROTTLE_STORE: async () => throttleSql,
  };
  const app = new Hono<{ Bindings: typeof env }>();
  app.use("*", sameOrigin);
  app.onError((error, c) =>
    isDatabaseUnavailable(error)
      ? c.text("Admin temporarily unavailable", 503, { "cache-control": "private, no-store" })
      : Promise.reject(error),
  );
  app.route("/admin", adminApp({ sessionStore, db }));
  async function get(
    renderer: Renderer,
    url: string,
    mode: "moderator" | "member" | "guest" = "moderator",
    admission?: Promise<void>,
  ) {
    if (renderer === "hono")
      return app.request(
        new URL(url, env.APP_URL).href,
        { headers: mode === "guest" ? {} : { cookie: mode === "member" ? memberCookie : cookie } },
        env,
      );
    const runtime = await kit();
    Reflect.set(globalThis, "__featuredReuseEnv", env);
    const full = new URL(url, env.APP_URL);
    const isNew = full.pathname === "/admin/featured/new";
    const headers = new Headers();
    try {
      const data = await (isNew ? runtime.newLoad : runtime.editLoad)({
        url: full,
        params: { id: full.pathname.split("/").at(-1) },
        parent: async () => {
          await admission;
          if (mode !== "moderator")
            throw Object.assign(new Error("fixture layout admission refusal"), {
              status: mode === "guest" ? 302 : 403,
              location: mode === "guest" ? "/auth/discord" : undefined,
            });
          return { actor: { id: MODERATOR.userId, username: MODERATOR.username } };
        },
        setHeaders: (entries: Record<string, string>) => {
          for (const [key, value] of Object.entries(entries)) {
            if (headers.has(key)) throw new Error("FR-FIXTURE Kit header already set");
            headers.set(key, value);
          }
        },
      });
      headers.set("content-type", "text/html; charset=UTF-8");
      return new Response(isNew ? runtime.renderNew(data) : runtime.renderEdit(data), { headers });
    } catch (error) {
      const refusal = error as { status?: number; location?: string; message?: string };
      if (!refusal.status) throw error;
      if (refusal.location) headers.set("location", refusal.location);
      headers.set("cache-control", "private, no-store");
      return new Response(refusal.message, { status: refusal.status, headers });
    }
  }
  function clearCalls() {
    statements.length = 0;
  }
  async function reuseUrl(renderer: Renderer, id = initial.id) {
    const edit = await get(renderer, `/admin/featured/${id}`);
    const href = reuseHref(await edit.text());
    clearCalls();
    // The contract intentionally does not choose a parameter name. Follow
    // the actual saved-editor link when implemented. The pre-feature fallback
    // reaches today's real empty-form handler and gives meaningful fail-first
    // output without failing every test solely on the missing link.
    return href ?? `/admin/featured/new?source=${id}`;
  }
  async function post(url: string, values: Record<string, string>, origin = env.APP_URL) {
    return app.request(
      new URL(url, env.APP_URL).href,
      {
        method: "POST",
        headers: {
          cookie,
          origin,
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(values),
      },
      env,
    );
  }
  async function followRecovery(renderer: Renderer, response: Response) {
    if (response.status === 303 || response.status === 302) {
      const target = new URL(response.headers.get("location")!, env.APP_URL);
      const honest =
        target.origin === env.APP_URL &&
        target.pathname === "/admin/featured/new" &&
        [...target.searchParams.values()].every((v) => !/^\d+$/.test(v));
      const next = await get(renderer, target.pathname + target.search);
      return { honest, html: await next.text() };
    }
    const html = await response.text();
    const doc = new HtmlView(parse(html));
    const recovery = doc.select(
      (e) =>
        e.tagName === "a" &&
        e.attrs.some((a) => a.name === "href" && a.value === "/admin/featured/new"),
    );
    const honest =
      [200, 404, 422].includes(response.status) &&
      !!recovery &&
      /invalid|missing|not found|no longer|unavailable|could not|cannot|couldn't|can't/i.test(
        doc.textContent,
      );
    const inlineForm = doc.select(
      (e) =>
        e.tagName === "form" &&
        e.attrs.some((a) => a.name === "action" && a.value.split("?")[0] === "/admin/featured"),
    );
    // An error document with a clearly labelled native recovery link is also
    // honest. Follow it only when the empty form is not already rendered.
    return {
      honest,
      html:
        honest && !inlineForm ? await (await get(renderer, "/admin/featured/new")).text() : html,
    };
  }
  return {
    origin: env.APP_URL,
    actorId: MODERATOR.userId,
    get,
    post,
    reuseUrl,
    followRecovery,
    clearCalls,
    throttleCalls: () => throttleCalls,
    limitWrites: () => {
      writeLimited = true;
    },
    reads: () =>
      statements.filter((s) => /^select\b/i.test(s.sql) && s.table === "featured_contents"),
    writes: () => statements.filter((s) => /^(?:insert|update|delete)\b/i.test(s.sql)),
    source: () => source,
    created: () => created,
    audit: () => audit,
    removeSource: () => {
      source = null;
    },
    failRead: () => {
      unavailable = true;
    },
  };
}
