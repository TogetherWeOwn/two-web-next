import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import { registerHotzoneRoutes } from "../../src/hotzones/routes";

export const periodOrigin = "https://period.example.test";
export type PeriodTwin = "Hono" | "Kit";
type Rendered = { head: string; body: string };
type KitEvent = {
  url: URL;
  params: { signal: string };
  setHeaders: (headers: Record<string, string>) => void;
};
export type PeriodKit = {
  index: (data: unknown) => Rendered;
  signal: (data: unknown) => Rendered;
  error: (status: number) => Rendered;
  loadIndex: (event: KitEvent) => Promise<unknown>;
  loadSignal: (event: KitEvent) => Promise<unknown>;
  setEnv: (env: Env) => void;
  css: string;
  dispose: () => void;
};

export async function compilePeriodKit(): Promise<PeriodKit> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const styles: string[] = [];
  const { outputFiles } = await build({
    stdin: {
      contents: `
import { render } from "svelte/server";
import Index from "./web/src/routes/hotzones/+page.svelte";
import Signal from "./web/src/routes/hotzones/[signal]/+page.svelte";
import ErrorPage from "./web/src/routes/+error.svelte";
import { page } from "$app/state";
export { load as loadIndex } from "./web/src/routes/hotzones/+page.server.ts";
export { load as loadSignal } from "./web/src/routes/hotzones/[signal]/+page.server.ts";
export { setEnv } from "cloudflare:workers";
export const index = (data) => render(Index, { props: { data } });
export const signal = (data) => render(Signal, { props: { data } });
export const error = (status) => { page.status = status; return render(ErrorPage); };
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
        name: "period-acceptance-ssr",
        setup(plugin) {
          // Replace only platform bindings, not either loader, parser or page.
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "bindings",
            namespace: "period-fixture",
          }));
          plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
            path: "state",
            namespace: "period-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "period-fixture" }, ({ path }) => ({
            contents:
              path === "state"
                ? "export const page = { status: 400 };"
                : "let current; export const setEnv = (value) => { current = value; }; export const env = new Proxy({}, { get: (_, key) => Reflect.get(current, key) });",
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
  return { ...compiled, css: styles.join("\n"), dispose: () => styles.splice(0) };
}

function documentHtml({ head, body }: Rendered) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body>${body}</body></html>`;
}

// Request-local injectable clock: replace Date only, never timers. This works
// before a production clock dependency exists and catches viewer-local date use
// when run with TZ=America/Los_Angeles. All routes/loads/HTML remain real.
export async function renderPeriodRequest(
  twin: PeriodTwin,
  path: string,
  kit: PeriodKit,
  now: Date,
) {
  const NativeDate = globalThis.Date;
  const nativeFetch = globalThis.fetch;
  const timestamp = now.getTime();
  let fetches = 0;
  let dbTouches = 0;
  const headers: Record<string, string> = {};
  const env = {
    APP_URL: periodOrigin,
    get ADMIN_DB() {
      dbTouches += 1;
      return undefined;
    },
  } as unknown as Env;
  globalThis.Date = new Proxy(NativeDate, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [timestamp]);
    },
    get(target, key) {
      return key === "now" ? () => timestamp : Reflect.get(target, key);
    },
  });
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("Period acceptance fixtures forbid network access");
  };
  try {
    let status = 200;
    let html: string;
    if (twin === "Hono") {
      const app = new Hono<{ Bindings: Env }>();
      registerHotzoneRoutes(app);
      const response = await app.request(path, {}, env);
      status = response.status;
      html = await response.text();
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else {
      kit.setEnv(env);
      const url = new URL(path, periodOrigin);
      const signal = url.pathname.split("/")[2] ?? "";
      const event: KitEvent = {
        url,
        params: { signal },
        setHeaders: (values) => Object.assign(headers, values),
      };
      try {
        const data = await (signal ? kit.loadSignal(event) : kit.loadIndex(event));
        html = documentHtml(signal ? kit.signal(data) : kit.index(data));
      } catch (error) {
        // Use the real Kit load's refusal and the compiled application error
        // page. Unexpected errors must fail the fixture, not become a fake 400.
        if (!(error && typeof error === "object" && "status" in error && error.status === 400))
          throw error;
        status = 400;
        html = documentHtml(kit.error(status));
      }
    }
    assert.equal(fetches, 0, "No analytics, database or remote fixture requests");
    return { status, html, headers, dbTouches };
  } finally {
    globalThis.Date = NativeDate;
    globalThis.fetch = nativeFetch;
  }
}

function text(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function attribute(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`\\b${escaped}=["']([^"']*)["']`, "i"))?.[1] ?? "";
}

export function periodControl(html: string) {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)]
    .map(([form]) => form)
    .filter((form) => /<(?:input|select)\b[^>]*name=["']season["']/i.test(form));
  assert.equal(forms.length, 1, "One native period form must exist in the rendered page");
  const form = forms[0]!;
  const input = form.match(/<(?:input|select)\b[^>]*name=["']season["'][^>]*>/i)?.[0] ?? "";
  const id = attribute(input, "id");
  assert.ok(id, "Period control must have an id for its visible label");
  const label = [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/gi)]
    .map(([tag]) => tag)
    .find((tag) => attribute(tag, "for") === id);
  const helpIds = attribute(input, "aria-describedby").split(/\s+/).filter(Boolean);
  assert.ok(helpIds.length, "Grammar help must be associated with the period control");
  const help = helpIds
    .map((helpId) => {
      const escaped = helpId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return text(
        html.match(
          new RegExp(`<([a-z][\\w-]*)\\b[^>]*id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "i"),
        )?.[2] ?? "",
      );
    })
    .join(" ");
  return {
    form: { html: form, method: attribute(form, "method"), action: attribute(form, "action") },
    control: {
      name: attribute(input, "name"),
      value: attribute(input, "value"),
      disabled: /\sdisabled(?:[\s=>]|$)/i.test(input),
    },
    label: text(label ?? ""),
    help,
  };
}

export function shortcut(html: string, label: string) {
  const links = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)]
    .map(([link]) => link)
    .filter((link) => text(link) === label);
  assert.equal(links.length, 1, `One native ${label} shortcut anchor must exist`);
  return { href: attribute(links[0]!, "href").replace(/&amp;/g, "&") };
}
