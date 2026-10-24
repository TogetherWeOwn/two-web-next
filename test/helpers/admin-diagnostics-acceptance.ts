// Acceptance-owned fixtures: real dashboard renderers, no route/DB substitutions.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { AdminDashboard } from "../../src/admin/pages";
import type { ZeroResultSearch } from "../../src/events/search-log";

export const DIAGNOSTIC_TWINS = ["Hono", "Kit"] as const;
export type DiagnosticTwin = (typeof DIAGNOSTIC_TWINS)[number];
export type DiagnosticState = "populated" | "empty" | "unavailable";
export const DIAGNOSTIC_STATES: DiagnosticState[] = ["populated", "empty", "unavailable"];
export const DIAGNOSTIC_OUTCOME = ' future/<recorded> & "quoted" +?#% ';
export const DIAGNOSTIC_FUNNEL = { added: 7, denied: 2, [DIAGNOSTIC_OUTCOME]: 3 };
export const DIAGNOSTIC_SEARCHES: ZeroResultSearch[] = [
  {
    query: 'fixture <chess> & "cards"',
    searches: 4,
    lastSearchedAt: new Date("2026-10-20T12:00:00.000Z"),
  },
];

export async function compileDiagnosticsKit() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
  };
  const scratch = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "diagnostics-ssr-",
    ),
  );
  const entry = join(scratch, "entry.mjs");
  const outfile = join(scratch, "bundle.mjs");
  writeFileSync(
    entry,
    `import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/admin/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + head + '</head><body>' + body + '</body></html>';
}`,
  );
  try {
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      logLevel: "warning",
      tsconfigRaw: {},
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib/") },
      plugins: [
        {
          name: "diagnostics-acceptance-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
              const { js } = compile(readFileSync(path, "utf8"), {
                generate: "server",
                dev: false,
                filename: path,
              });
              return { contents: js.code, loader: "js", resolveDir: dirname(path) };
            });
          },
        },
      ],
    });
    const { renderPage } = (await import(pathToFileURL(outfile).href)) as {
      renderPage: (data: Record<string, unknown>) => string;
    };
    return { renderPage, dispose: () => rmSync(scratch, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

export function renderDiagnostics(
  twin: DiagnosticTwin,
  kit: Awaited<ReturnType<typeof compileDiagnosticsKit>>,
  funnelState: DiagnosticState,
  searchState: DiagnosticState,
): string {
  const actor = { id: "fixture-mod", username: "Fixture moderator" };
  const funnel =
    funnelState === "unavailable" ? undefined : funnelState === "empty" ? {} : DIAGNOSTIC_FUNNEL;
  const zeroSearches =
    searchState === "unavailable" ? undefined : searchState === "empty" ? [] : DIAGNOSTIC_SEARCHES;
  if (twin === "Hono") return String(jsx(AdminDashboard, { actor, funnel, zeroSearches }));
  return kit.renderPage({
    actor,
    funnel,
    retentionDays: 90,
    zeroSearches: zeroSearches?.map((row) => ({
      ...row,
      lastSearchedAt: row.lastSearchedAt.toISOString(),
    })),
  });
}
