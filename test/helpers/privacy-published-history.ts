import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import type { Env } from "../../src/env";

export const historyRoot = fileURLToPath(new URL("../../", import.meta.url));
export const historyOrigin = "https://privacy.example.test";
export type HistoryTwin = "Hono" | "Kit";
export type HistoryTarget = {
  id: string;
  version: number;
  sourcePath: string;
  sourceCommit: string;
  href: string;
};
export type HistoryAuthority = {
  PREVIOUS_PUBLISHED_POLICIES?: readonly HistoryTarget[];
  checkPublishedPolicyTarget?: (id: string) => unknown;
};
export type PrivacyHistoryFixture = {
  history: HistoryAuthority;
  csr: boolean;
  css: string;
  modules: string[];
  setEnv: (value: Env) => void;
  load: (event: unknown) => Promise<Record<string, unknown>>;
  renderKit: (data: unknown) => { head: string; body: string };
  request: (path: string, cookie?: string) => Promise<Response>;
};

// Execute both real route registrations and the real Kit load/page. Only the
// platform binding is replaced; no fabricated privacy HTML or mirrored load DTO.
export async function compilePrivacyHistory(): Promise<PrivacyHistoryFixture> {
  const webRequire = createRequire(join(historyRoot, "web/package.json"));
  const { compile } = webRequire("svelte/compiler");
  const styles: string[] = [];
  const authority = existsSync(join(historyRoot, "src/privacy-history.ts"))
    ? 'export * as history from "./src/privacy-history.ts";'
    : "export const history = {};";
  const result = await build({
    stdin: {
      contents: `
import { render } from "svelte/server";
import { Hono } from "hono";
import Page from "./web/src/routes/privacy/+page.svelte";
import { registerSeoLeaves } from "./src/seo-leaves.tsx";
import { registerAiFriendlyRoutes } from "./src/ai-friendly/routes.ts";
import { env } from "cloudflare:workers";
export { setEnv } from "cloudflare:workers";
export { load, csr } from "./web/src/routes/privacy/+page.server.ts";
${authority}
const app = new Hono();
registerSeoLeaves(app);
registerAiFriendlyRoutes(app);
export const request = (path, cookie) => app.request(new URL(path, env.APP_URL), { headers: cookie ? {cookie} : {} }, env);
export const renderKit = (data) => render(Page, { props: { data } });
`,
      resolveDir: historyRoot,
      loader: "js",
    },
    absWorkingDir: historyRoot,
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "hono/jsx" } },
    nodePaths: [join(historyRoot, "web/node_modules"), join(historyRoot, "node_modules")],
    alias: { "#lib": join(historyRoot, "web/src/lib") },
    banner: {
      js: `import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(${JSON.stringify(join(historyRoot, "package.json"))});`,
    },
    plugins: [
      {
        name: "privacy-history-real-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "bindings",
            namespace: "privacy-history-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "privacy-history-fixture" }, () => ({
            contents:
              "let current; export const setEnv = (value) => { current = value; }; export const env = new Proxy({}, { get: (_, key) => Reflect.get(current, key) });",
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
    ...compiled,
    css: styles.join("\n"),
    modules: Object.keys(result.metafile!.inputs).filter((path) => !path.includes("node_modules/")),
  };
}

export function guardedPrivacyEnv() {
  const touches: string[] = [];
  const target = {
    APP_URL: historyOrigin,
    DISCORD_INVITE_URL: "https://discord.gg/configured",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  };
  const env = new Proxy(target, {
    get(value, key) {
      if (
        ["ADMIN_DB", "DATABASE_URL", "DB", "SESSION_STORE", "ROSTER_STORE"].includes(String(key))
      ) {
        touches.push(String(key));
        throw new Error("Privacy fixture forbids data/session access");
      }
      return Reflect.get(value, key);
    },
  }) as Env;
  return { env, touches };
}

export async function renderPrivacyHistory(
  fixture: PrivacyHistoryFixture,
  twin: HistoryTwin,
  cookie?: string,
) {
  const { env, touches } = guardedPrivacyEnv();
  fixture.setEnv(env);
  const headers: Record<string, string> = {};
  let html: string;
  let status = 200;
  if (twin === "Hono") {
    const response = await fixture.request("/privacy", cookie);
    status = response.status;
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    html = await response.text();
  } else {
    const event = new Proxy(
      {
        url: new URL("/privacy", historyOrigin),
        setHeaders: (values: Record<string, string>) => Object.assign(headers, values),
      },
      {
        get(value, key) {
          if (["cookies", "locals", "platform", "fetch", "parent"].includes(String(key))) {
            touches.push(String(key));
            throw new Error("Privacy load must not read viewer or external state");
          }
          return Reflect.get(value, key);
        },
      },
    );
    const data = await fixture.load(event);
    const page = fixture.renderKit(data);
    html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${page.head}</head><body>${page.body}</body></html>`;
  }
  return { html, status, headers, touches };
}
