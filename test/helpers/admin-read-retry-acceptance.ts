// Real Kit boundaries, with only the request-local $app/state replaced.
// No implementation helper is imported into the expected-value side.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

export const ADMIN_RETRY_ORIGIN = "https://admin-retry.example.test";
export const ADMIN_RETRY_CANARY = "private-read-failure-<script>exception</script>";
export type AdminBoundary = "admin" | "join-attempts";
export type RenderedAdminError = { head: string; body: string };
export type RetryPage = {
  status: number;
  url?: unknown;
  error?: Record<string, unknown>;
  route?: { id: string | null };
  params?: Record<string, string>;
};
export type AdminRetryKit = {
  render: (boundary: AdminBoundary, page: RetryPage) => RenderedAdminError;
  inputs: string[];
  css: string;
};

export const ADMIN_RETRY_VIEWS = [
  { boundary: "admin", path: "/admin", routeId: "/admin" },
  { boundary: "admin", path: "/admin/events?page=2&status=published", routeId: "/admin/events" },
  {
    boundary: "admin",
    path: "/admin/events/no-such-key?from=list&page=2",
    routeId: "/admin/events/[key]",
  },
  { boundary: "admin", path: "/admin/featured?page=2", routeId: "/admin/featured" },
  {
    boundary: "admin",
    path: "/admin/featured/999999?from=list&page=2",
    routeId: "/admin/featured/[id]",
  },
  {
    boundary: "admin",
    path: "/admin/activity-log?page=2&subject=event",
    routeId: "/admin/activity-log",
  },
  {
    boundary: "join-attempts",
    path: "/admin/join-attempts?page=2&status=failed",
    routeId: "/admin/join-attempts",
  },
  {
    boundary: "join-attempts",
    path: "/admin/join-attempts/7?page=2&status=failed",
    routeId: "/admin/join-attempts/[id]",
  },
] as const;

export function retryPage(status: number, path: string, routeId: string): RetryPage {
  return {
    status,
    url: new URL(path, ADMIN_RETRY_ORIGIN),
    route: { id: routeId },
    params: {},
    error: { message: ADMIN_RETRY_CANARY, stack: ADMIN_RETRY_CANARY },
  };
}

export async function compileAdminRetryKit(): Promise<AdminRetryKit> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const styles: string[] = [];
  const result = await build({
    stdin: {
      contents: `
import { render } from "svelte/server";
import Admin from "./web/src/routes/admin/+error.svelte";
import JoinAttempts from "./web/src/routes/admin/join-attempts/+error.svelte";
import { setPage } from "$app/state";
export function renderBoundary(boundary, page) {
  setPage(page);
  const { head, body } = render(boundary === "admin" ? Admin : JoinAttempts);
  return { head, body };
}
`,
      loader: "js",
      resolveDir: root,
    },
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib") },
    plugins: [
      {
        name: "admin-read-retry-fixture",
        setup(plugin) {
          plugin.onResolve({ filter: /^\$app\/state$/ }, () => ({
            path: "state",
            namespace: "admin-retry-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "admin-retry-fixture" }, () => ({
            contents: "export let page = {}; export function setPage(value) { page = value; }",
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
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`
  );
  return {
    render: compiled.renderBoundary,
    inputs: Object.keys(result.metafile!.inputs),
    css: styles.join("\n"),
  };
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27);/gi, (entity) => {
    const decoded: Record<string, string> = {
      "&amp;": "&",
      "&quot;": '"',
      "&apos;": "'",
      "&#39;": "'",
      "&#x27;": "'",
      "&lt;": "<",
      "&gt;": ">",
    };
    return decoded[entity.toLowerCase()]!;
  });
}

export function anchors(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    attributes: match[1]!,
    href: decodeHtml(/\bhref="([^"]*)"/i.exec(match[1]!)?.[1] ?? ""),
    name: decodeHtml(match[2]!.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim(),
  }));
}

export function retryAnchors(html: string) {
  return anchors(html).filter((anchor) => /^Retry loading(?:\b|$)/i.test(anchor.name));
}
