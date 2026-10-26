import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import { transformContentLeafChunk } from "../../src/kit-content-chunk";
import { POLICY_MARKDOWN } from "../../src/privacy-content";
import { registerSeoLeaves } from "../../src/seo-leaves";

export const PRIVACY_NAV_ORIGIN = "https://privacy-nav.example.test";
export type PrivacyNavRenderer = "Hono" | "Kit";

type RenderedPrivacy = { html: string; headers: Record<string, string>; status: number };
type KitFixture = {
  renderPage: () => Promise<RenderedPrivacy>;
};

/** The six `## ` section titles in policy order, parsed from the live source. */
export function policySectionTitles(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

export const POLICY_SECTION_TITLES = policySectionTitles(POLICY_MARKDOWN);

export async function createPrivacySectionFixture() {
  const worktree = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "privacy-section-"),
  );
  const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: string; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };
  const entry = join(scratch, "entry.mjs");
  const outfile = join(scratch, "privacy.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/privacy/+page.svelte"))};
import { load, csr } from ${JSON.stringify(join(worktree, "web/src/routes/privacy/+page.server.ts"))};
export { csr };
export async function renderPage() {
  const headers = {};
  const data = await load({ setHeaders: values => Object.assign(headers, values) });
  const { head, body } = render(Page, { props: { data } });
  return { html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + head + '</head><body>' + body + '</body></html>', headers, status: 200 };
}
`,
  );
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    metafile: true,
    logLevel: "warning",
    absWorkingDir: worktree,
    nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
    alias: { "#lib": join(worktree, "web/src/lib") },
    plugins: [
      {
        name: "privacy-section-real-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "env",
            namespace: "privacy-section-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "privacy-section-fixture" }, () => ({
            contents: `export const env = new Proxy({ APP_URL: ${JSON.stringify(PRIVACY_NAV_ORIGIN)} }, { get(target, key) { if (!(key in target)) throw new Error("Unexpected privacy binding read: " + String(key)); return target[key]; } });`,
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
  const kit = (await import(pathToFileURL(outfile).href)) as KitFixture & { csr: boolean };
  const modules = Object.keys(result.metafile.inputs).filter(
    (path) => !path.includes("node_modules/"),
  );
  const app = new Hono<{ Bindings: Env }>();
  registerSeoLeaves(app);
  return {
    modules,
    csr: kit.csr,
    async render(renderer: PrivacyNavRenderer): Promise<RenderedPrivacy> {
      if (renderer === "Kit") {
        const rendered = await kit.renderPage();
        return { ...rendered, html: transformContentLeafChunk(rendered.html) };
      }
      const bindings = new Proxy(
        { APP_URL: PRIVACY_NAV_ORIGIN },
        {
          get(target, key) {
            if (!(key in target))
              throw new Error(`Unexpected privacy binding read: ${String(key)}`);
            return target[key as keyof typeof target];
          },
        },
      ) as Env;
      const response = await app.request(
        `${PRIVACY_NAV_ORIGIN}/privacy`,
        { headers: { cookie: "session=untrusted-visitor" } },
        bindings,
      );
      return {
        html: await response.text(),
        headers: Object.fromEntries(response.headers),
        status: response.status,
      };
    },
    close() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
