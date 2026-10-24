// Test Author owned. Local renderers only; no route loads, external reads or DB.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { formFixtures, root, type FormFixture } from "./admin-validation-correction";

const routes = {
  dashboard: "",
  events: "events",
  eventNew: "events/new",
  eventEdit: "events/[key]",
  featured: "featured",
  featuredNew: "featured/new",
  featuredEdit: "featured/[id]",
  joins: "join-attempts",
  joinDetail: "join-attempts/[id]",
  activity: "activity-log",
} as const;
export type AdminPage = keyof typeof routes | "error" | "joinError";
export type Rendered = { head: string; body: string };
export type OrientationRenderer = (
  name: AdminPage,
  path: string,
  data?: unknown,
  status?: number,
  routeId?: string,
) => Rendered;

export async function compileOrientation(): Promise<OrientationRenderer> {
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const entries = {
    ...Object.fromEntries(
      Object.entries(routes).map(([name, route]) => [
        name,
        `web/src/routes/admin/${route ? `${route}/` : ""}+page.svelte`,
      ]),
    ),
    error: "web/src/routes/admin/+error.svelte",
    joinError: "web/src/routes/admin/join-attempts/+error.svelte",
  };
  const { outputFiles } = await build({
    stdin: {
      contents: [
        'import { render } from "svelte/server";',
        'import { setPage } from "$app/state";',
        ...Object.entries(entries).map(
          ([name, path]) => `import ${name} from ${JSON.stringify(join(root, path))};`,
        ),
        `const pages = {${Object.keys(entries).join(",")}};`,
        "export function renderPage(name, url, data, status, routeId) {",
        "  setPage({ url: new URL(url), status, route: { id: routeId }, params: {}, error: { message: 'Private diagnostic must not render' } });",
        "  const { head, body } = render(pages[name], { props: { data } });",
        "  return { head, body };",
        "}",
      ].join("\n"),
      resolveDir: root,
      loader: "js",
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    tsconfigRaw: { compilerOptions: {} },
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "admin-orientation-local-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
            path: "page",
            namespace: "admin-orientation",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "admin-orientation" }, () => ({
            contents: "export let page; export const setPage = (value) => { page = value; };",
            loader: "js",
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
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0]!.text).toString("base64")}`
  );
  return (name, path, data = {}, status = 200, routeId) => {
    const route = name in routes ? routes[name as keyof typeof routes] : "";
    return mod.renderPage(
      name,
      new URL(path, "https://next.example.test").href,
      data,
      status,
      routeId ?? `/admin${route ? `/${route}` : ""}`,
    );
  };
}

export function documentFor(rendered: Rendered): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${rendered.head}</head><body>${rendered.body}</body></html>`;
}

// Reuse row fixtures, not their state-less compiler. Each Kit render must receive
// its own real URL/route, so navigation cannot accidentally retain a prior page.
export async function orientationForms(
  render: OrientationRenderer,
  rejected = false,
): Promise<FormFixture[]> {
  const names = ["eventNew", "eventEdit", "featuredNew", "featuredEdit"] as const;
  const paths = [
    "/admin/events/new",
    "/admin/events/01J0000000000000000000ABCD",
    "/admin/featured/new",
    "/admin/featured/7",
  ];
  return formFixtures(
    {
      renderForm: (index, data) => documentFor(render(names[index]!, paths[index]!, data)),
      dispose: () => undefined,
    },
    rejected,
  );
}

export function linksIn(html: string): { tag: string; href: string; current: string | null }[] {
  return [...html.matchAll(/<a\b[^>]*>/g)].map(([tag]) => ({
    tag,
    href: /\bhref="([^"]*)"/.exec(tag)?.[1] ?? "",
    current: /\baria-current="([^"]*)"/.exec(tag)?.[1] ?? null,
  }));
}

export function headerLinks(html: string) {
  return linksIn(/<header\b[^>]*>[\s\S]*?<\/header>/.exec(html)?.[0] ?? "");
}

export function upperLinks(html: string) {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
  const firstField = main.search(/<(?:input|textarea|select)\b/);
  return linksIn(firstField < 0 ? "" : main.slice(0, firstField));
}
