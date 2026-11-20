import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  dispatchHookRequest,
  type HookDispatchDeps,
} from "../src/route-ownership";

const APP_URL = "https://next.togetherweown.com";
const LEAVES = [
  ["about", 'data-testid="about-facts"'],
  ["faq", 'data-testid="faq-list"'],
  ["privacy", "<h2>Who we are</h2>"],
  ["rules", 'data-testid="rules-list"'],
] as const;

type Fixture = {
  csr: boolean;
  load: (args: {
    setHeaders: (headers: Record<string, string>) => void;
  }) => Promise<Record<string, unknown>>;
  render: (data: Record<string, unknown>) => string;
};

let fixtures: Record<(typeof LEAVES)[number][0], Fixture>;

beforeAll(async () => {
  // Compile the real page and load together. Only the Worker env and the
  // framework's outer HTML/resolve seam are fixtures; no DB is configured.
  const root = fileURLToPath(new URL("../", import.meta.url));
  const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
  const { compile } = requireWeb("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: "server"; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };
  const scratch = mkdtempSync(join(tmpdir(), "kit-archive-static-"));
  try {
    const outfile = join(scratch, "leaves.mjs");
    await build({
      stdin: {
        contents: [
          'import { render } from "svelte/server";',
          ...LEAVES.flatMap(([leaf], i) => [
            `import Page${i} from "./web/src/routes/${leaf}/+page.svelte";`,
            `import { csr as csr${i}, load as load${i} } from "./web/src/routes/${leaf}/+page.server.ts";`,
            `export const ${leaf} = { csr: csr${i}, load: load${i}, render: (data) => document(Page${i}, data) };`,
          ]),
          `function document(Page, data) {
            const { head, body } = render(Page, { props: { data } });
            return '<!doctype html><html><head><link rel="stylesheet" href="/layout.css">' + head + '</head><body>' + body + '</body></html>';
          }`,
        ].join("\n"),
        resolveDir: root,
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "warning",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      plugins: [
        {
          name: "archive-static-ssr",
          setup(plugin) {
            plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "worker-env",
              namespace: "archive-static-fixture",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "archive-static-fixture" }, () => ({
              contents: `export const env = ${JSON.stringify({ APP_URL })};`,
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
    fixtures = (await import(pathToFileURL(outfile).href)) as typeof fixtures;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("staging archive-static Kit SSR", () => {
  it.each(LEAVES)("serves /%s without JavaScript, DB, or session reads", async (leaf, marker) => {
    const { csr, load, render } = fixtures[leaf];
    expect(csr).toBe(false);
    const path = `/${leaf}`;
    const url = new URL(path, APP_URL);
    const request = new Request(url);
    const honoFetch = vi.fn(async () => new Response("hono"));
    const sessionFor = vi.fn(async () => {
      throw new Error("session unavailable");
    });
    const accessSink = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const resolve = vi.fn<HookDispatchDeps["resolve"]>(async (_event, options) => {
      const headers = new Headers({ "content-type": "text/html" });
      const data = await load({
        setHeaders: (entries) => {
          for (const [name, value] of Object.entries(entries)) headers.set(name, value);
        },
      });
      const html = render(data);
      return new Response(options?.transformPageChunk?.({ html }) ?? html, { headers });
    });

    const response = await dispatchHookRequest(
      { request, url, route: { id: path } },
      {
        appUrl: APP_URL,
        kitRouteArchive: "true",
        kitRouteStatic: "true",
        honoFetch,
        resolve,
        sessionFor,
        accessSink,
      },
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
    expect(resolve).toHaveBeenCalledOnce();
    expect(honoFetch).not.toHaveBeenCalled();
    expect(sessionFor).not.toHaveBeenCalled();
    expect(accessSink).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(html).toContain(marker);
    expect(html).not.toMatch(/<script\b|rel="stylesheet"/i);
    const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    expect(css).toBeTruthy();
    const hash = createHash("sha256").update(css ?? "").digest("base64");
    const csp = response.headers.get("content-security-policy")?.split("; ");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(`style-src 'self' 'sha256-${hash}'`);
  });
});
