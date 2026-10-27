import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import { transformContentLeafChunk } from "../../src/kit-content-chunk";
import { RULES } from "../../src/rules-content";
import { registerStaticLeaves } from "../../src/static-leaves";

export const RULE_ORIGIN = "https://rules.example.test";
export const RULE_COPY = [
  [
    "18+ only",
    "Together We Own is an adult gaming community. If you are under 18, this is not your lobby yet.",
  ],
  [
    "Respect the room",
    "No harassment, hate, or punching down. Argue about games all you like; never about people.",
  ],
  [
    "Voice-first",
    "The community lives in voice. Turn up, say hello, and come back — that is the whole membership path.",
  ],
  [
    "Play fair",
    "No cheating, exploits, or griefing. Do not spoil the game for the people you share it with.",
  ],
  [
    "Moderators have the last word",
    "If a moderator asks you to stop, stop. Appeals happen in private, not in the lobby.",
  ],
] as const;
export const LONG_RULE_LABEL =
  "Respect every person sharing this room, including newcomers joining a very long conversation";
export type RulesRenderer = "Hono" | "Kit";
export type RuleRows = typeof RULES;

type RenderedRules = { html: string; headers: Record<string, string>; status: number };
type KitFixture = {
  renderPage: (rules: RuleRows, stamp: string | undefined) => Promise<RenderedRules>;
};

// Change only fixture wording/order, retaining whatever explicit identity the
// shared content carries. This deliberately does not prescribe tuple/object IDs.
export function changedRuleRows(reverse = false): RuleRows {
  const replacements = new Map<string, string>([
    [RULE_COPY[1][0], LONG_RULE_LABEL],
    [RULE_COPY[1][1], "Different fixture wording; the same rule must keep its address."],
  ]);
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return replacements.get(value) ?? value;
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
    }
    return value;
  };
  const rows = visit(RULES) as RuleRows;
  return reverse ? rows.reverse() : rows;
}

export async function createRulesFixture() {
  const worktree = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "rules-anchor-"),
  );
  const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: { generate: string; dev: boolean; filename: string },
    ) => { js: { code: string } };
  };
  const entry = join(scratch, "entry.mjs");
  const outfile = join(scratch, "rules.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(worktree, "web/src/routes/rules/+page.svelte"))};
import { load, csr } from ${JSON.stringify(join(worktree, "web/src/routes/rules/+page.server.ts"))};
import { env } from "cloudflare:workers";
export { csr };
export async function renderPage(rules, stamp) {
  env.RULES_LAST_UPDATED = stamp;
  const headers = {};
  const data = await load({ setHeaders: values => Object.assign(headers, values) });
  const { head, body } = render(Page, { props: { data: { ...data, rules } } });
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
        name: "rules-anchor-real-ssr",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "env",
            namespace: "rules-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "rules-fixture" }, () => ({
            contents: `export const env = new Proxy({ APP_URL: ${JSON.stringify(RULE_ORIGIN)}, RULES_LAST_UPDATED: undefined }, { get(target, key) { if (!(key in target)) throw new Error("Unexpected rules binding read: " + String(key)); return target[key]; } });`,
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
  registerStaticLeaves(app);
  return {
    modules,
    csr: kit.csr,
    async render(
      renderer: RulesRenderer,
      rows: RuleRows = RULES,
      stamp: string | undefined = "2026-09-01",
    ): Promise<RenderedRules> {
      if (renderer === "Kit") {
        const rendered = await kit.renderPage(rows, stamp);
        return { ...rendered, html: transformContentLeafChunk(rendered.html) };
      }
      const original = [...RULES];
      try {
        RULES.splice(0, RULES.length, ...rows);
        const bindings = new Proxy(
          { APP_URL: RULE_ORIGIN, RULES_LAST_UPDATED: stamp },
          {
            get(target, key) {
              if (!(key in target))
                throw new Error(`Unexpected rules binding read: ${String(key)}`);
              return target[key as keyof typeof target];
            },
          },
        ) as Env;
        const response = await app.request(
          `${RULE_ORIGIN}/rules`,
          { headers: { cookie: "session=untrusted-visitor" } },
          bindings,
        );
        return {
          html: await response.text(),
          headers: Object.fromEntries(response.headers),
          status: response.status,
        };
      } finally {
        RULES.splice(0, RULES.length, ...original);
      }
    },
    close() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
