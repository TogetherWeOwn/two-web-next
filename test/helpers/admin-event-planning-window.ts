// Real Kit events loader + compiled SSR page. Only Workers binding transport is replaced.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import type { Env } from "../../src/env";

export async function compilePlanningWindowKit() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler");
  const styles: string[] = [];
  const { outputFiles } = await build({
    stdin: {
      contents: `
import { render } from "svelte/server";
import Page from "./web/src/routes/admin/events/+page.svelte";
import ErrorPage from "./web/src/routes/+error.svelte";
import { setPage } from "$app/state";
import { load } from "./web/src/routes/admin/events/+page.server.ts";
import { memberReadResponse } from "./src/member-reads.ts";
import { setEnv } from "cloudflare:workers";
export async function request({env, path, actor = "moderator"}) {
  setEnv(env);
  const headers = new Headers({"content-type": "text/html; charset=utf-8"});
  const actorData = {id: "100000000000000111", username: "Fixture moderator"};
  return memberReadResponse(
    {method: "GET", route: "/admin/events"},
    {viewer: actorData.id, resource: "admin", action: "list", route: "admin.events"},
    async () => { throw new Error("Event inventory must not create member-access subjects"); },
    async () => {
      try {
        const data = await load({
          url: new URL(path, env.APP_URL),
          parent: async () => {
            if (actor === "guest") throw Object.assign(new Error("Sign in"), {status: 302, location: "/auth/discord"});
            if (actor !== "moderator") throw Object.assign(new Error("Forbidden"), {status: 403});
            return {actor: actorData};
          },
          setHeaders: values => {for (const [key, value] of Object.entries(values)) headers.set(key, value);}
        });
        const {head, body} = render(Page, {props: {data}});
        return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + head + '</head><body>' + body + '</body></html>', {headers});
      } catch (error) {
        if (![302, 400, 403, 422, 503].includes(error?.status)) throw error;
        if (error.location) headers.set("location", error.location);
        if (error.status === 302) return new Response("", {status: 302, headers});
        setPage({status: error.status, url: new URL(path, env.APP_URL), error: error.body ?? {message: error.message}, data: {}});
        const {head, body} = render(ErrorPage);
        return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8">' + head + '</head><body>' + body + '</body></html>', {status: error.status, headers});
      }
    }
  );
}
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
      js: `import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(${JSON.stringify(join(root, "package.json"))});`,
    },
    plugins: [
      {
        name: "planning-window-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "bindings",
            namespace: "planning-window",
          }));
          plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
            path: "page-state",
            namespace: "planning-window",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "planning-window" }, ({ path }) => ({
            contents:
              path === "page-state"
                ? "export let page = {}; export const setPage = value => {page = value;};"
                : "let current; export const setEnv = value => { current = value; }; export const env = new Proxy({}, {get: (_, key) => Reflect.get(current, key)});",
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
    `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
  );
  return {
    request: compiled.request as (args: {
      env: Env;
      path: string;
      actor?: "moderator" | "guest" | "member";
    }) => Promise<Response>,
    css: styles.join("\n"),
  };
}
