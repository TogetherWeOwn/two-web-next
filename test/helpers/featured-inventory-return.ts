// Acceptance transport only: real Hono controllers, actual Kit loader and Svelte SSR.
// The database binding is replaced, never the reader or the returned view model.
import { build } from "esbuild";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { adminApp } from "../../src/admin/routes";
import { sameOrigin } from "../../src/same-origin";
import type { Db } from "../../src/db";
import { createMemorySessionStore } from "../../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR } from "./member-data";
import {
  inventoryDb,
  inventoryRow,
  origin,
  renderInventory,
  type Renderer,
} from "./admin-inventory-recovery";

export { origin, renderInventory, type Renderer };
export const query = 'Café 🎲 & "co-op" <slot>';
export const search = `?${new URLSearchParams({ q: query, published: "0", sort: "updated_at", order: "desc", page: "2" })}`;
export const slot = {
  ...inventoryRow("featured", 7),
  title: `${query} evening`,
  isPublished: false,
  startsAtText: null,
  endsAtText: null,
};
export type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];
export function elements(node: Node | string, tag?: string): Element[] {
  const root = typeof node === "string" ? parse(node) : node;
  const found: Element[] = [];
  const visit = (n: Node) => {
    if ("tagName" in n && (!tag || n.tagName === tag)) found.push(n);
    if ("childNodes" in n) n.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}
export const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value;
export function text(node: Node): string {
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}
export const links = (html: string) =>
  elements(html, "a").map((a) => ({
    label: text(a).trim().replace(/\s+/g, " "),
    url: new URL(attr(a, "href") ?? "", origin),
  }));
export function editLink(html: string): URL {
  const link = links(html).find((a) => a.url.pathname === "/admin/featured/7");
  if (!link) throw new Error("The real inventory did not render the fixture slot link");
  return link.url;
}
export async function entry(renderer: Renderer, suffix = search) {
  const result = await renderInventory(renderer, "featured", suffix, [slot]);
  if (result.status !== 200) throw new Error(`Inventory fixture refused: ${result.status}`);
  return { ...result, url: editLink(result.html) };
}
export function editorForm(html: string, deletion = false) {
  const form = elements(html, "form").find((form) =>
    elements(form, "button").some(
      (button) => attr(button, "data-testid") === (deletion ? "delete-featured" : "save-featured"),
    ),
  );
  if (!form) throw new Error("Real editor is missing its native form");
  const fields = new URLSearchParams();
  for (const input of elements(form, "input")) {
    const name = attr(input, "name");
    const type = attr(input, "type");
    if (
      !name ||
      attr(input, "disabled") !== undefined ||
      ["submit", "button", "reset"].includes(type ?? "")
    )
      continue;
    if (["checkbox", "radio"].includes(type ?? "") && attr(input, "checked") === undefined)
      continue;
    fields.append(name, attr(input, "value") ?? (type === "checkbox" ? "on" : ""));
  }
  for (const input of elements(form, "textarea")) {
    const name = attr(input, "name");
    if (name) fields.append(name, text(input));
  }
  const button = elements(form, "button").find(
    (b) => attr(b, "data-testid") === (deletion ? "delete-featured" : "save-featured"),
  )!;
  const name = attr(button, "name");
  if (name) fields.append(name, attr(button, "value") ?? "");
  return { node: form, action: attr(form, "action") ?? "", method: attr(form, "method"), fields };
}

const root = process.cwd();
const binding = "__featuredInventoryReturnBinding";
type KitEvent = {
  url: URL;
  params: { id: string };
  parent: () => Promise<unknown>;
  setHeaders: (h: Record<string, string>) => void;
};
type KitRuntime = {
  load: (event: KitEvent) => Promise<Record<string, unknown>>;
  renderPage: (data: unknown) => string;
};
let compiled: Promise<KitRuntime> | undefined;
export function compileFeaturedReturnKit(): Promise<KitRuntime> {
  return (compiled ??= (async () => {
    const webRequire = createRequire(resolve(root, "web/package.json"));
    const { compile } = webRequire("svelte/compiler");
    const styles: string[] = [];
    const result = await build({
      stdin: {
        contents: `import { render } from 'svelte/server';
        import Page from './web/src/routes/admin/featured/[id]/+page.svelte';
        export { load } from './web/src/routes/admin/featured/[id]/+page.server.ts';
        export const renderPage = (data) => render(Page, { props: { data } }).body;`,
        resolveDir: root,
      },
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
          name: "featured-return-acceptance",
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
                    ? `export const env = { APP_URL: ${JSON.stringify(origin)} };`
                    : `export async function dbFor() { const b = globalThis.${binding}; b.calls++; return b.db; }`,
              loader: "js",
            }));
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
              const output = compile(readFileSync(path, "utf8"), {
                generate: "server",
                dev: false,
                filename: path,
              });
              if (output.css?.code) styles.push(output.css.code);
              return { contents: output.js.code, loader: "js", resolveDir: dirname(path) };
            });
          },
        },
      ],
    });
    const runtime = (await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`
    )) as KitRuntime;
    return {
      load: runtime.load,
      renderPage: (data) => `<style>${styles.join("\n")}</style>${runtime.renderPage(data)}`,
    };
  })());
}

export async function honoSession(
  db: Db,
  admission: "moderator" | "member" | "guest" = "moderator",
) {
  const store = createMemorySessionStore();
  const cookie =
    admission === "guest"
      ? ""
      : await cookieFor(store, admission === "member" ? MEMBER : MODERATOR);
  const app = new Hono()
    .use("*", sameOrigin)
    .route("/admin", adminApp({ sessionStore: store, db }));
  return (path: string | URL, init: RequestInit = {}) =>
    app.request(
      new URL(String(path), origin).href,
      {
        ...init,
        headers: { cookie, origin, ...Object.fromEntries(new Headers(init.headers)) },
      },
      { ...env, APP_URL: origin, ADMIN_DB: db },
    );
}
export async function renderEditor(
  renderer: Renderer,
  url: URL,
  options: { db?: Db; admission?: "moderator" | "member" | "guest" } = {},
) {
  const probe = inventoryDb("featured", [slot]);
  const db = options.db ?? probe.db;
  if (renderer === "Hono") {
    const response = await (await honoSession(db, options.admission))(url);
    return {
      html: await response.text(),
      status: response.status,
      headers: response.headers,
      probe,
      bindingCalls: 0,
    };
  }
  const runtime = await compileFeaturedReturnKit();
  const context = { db, calls: 0 };
  Reflect.set(globalThis, binding, context);
  const headers = new Headers();
  try {
    const data = await runtime.load({
      url,
      params: { id: url.pathname.split("/").at(-1)! },
      parent: async () => {
        if (options.admission && options.admission !== "moderator")
          throw Object.assign(new Error("Admission refused"), {
            status: options.admission === "guest" ? 302 : 403,
          });
        return { actor: MODERATOR };
      },
      setHeaders: (h) => {
        for (const [k, v] of Object.entries(h)) headers.set(k, v);
      },
    });
    return {
      html: runtime.renderPage(data),
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
