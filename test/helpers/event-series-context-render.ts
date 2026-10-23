import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";

const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => { js: { code: string } };
};

let cachedRender: ((model: Record<string, unknown>) => string) | null = null;
export async function renderSeriesDetail(model: Record<string, unknown>): Promise<string> {
  if (!cachedRender) {
    const worktree = fileURLToPath(new URL("../../", import.meta.url));
    const scratch = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-series-context-"),
    );
    try {
      const entry = join(scratch, "entry.mjs");
      writeFileSync(
        entry,
        `
import { render } from "svelte/server";
import Detail from ${JSON.stringify(join(worktree, "web/src/lib/EventDetail.svelte"))};
export function renderDetail(model) {
  const { head, body } = render(Detail, { props: { model } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
      );
      const outfile = join(scratch, "bundle.mjs");
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile,
        logLevel: "warning",
        absWorkingDir: worktree,
        nodePaths: [join(worktree, "web/node_modules"), join(worktree, "node_modules")],
        alias: { "#lib": join(worktree, "web/src/lib/") },
        plugins: [
          {
            name: "kit-series-context-ssr",
            setup(plugin) {
              plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
                const { js } = compile(readFileSync(args.path, "utf8"), {
                  generate: "server",
                  dev: false,
                  filename: args.path,
                });
                return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
              });
            },
          },
        ],
      });
      const bundle = (await import(pathToFileURL(outfile).href)) as {
        renderDetail: (model: Record<string, unknown>) => string;
      };
      cachedRender = bundle.renderDetail;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return cachedRender!(model);
}
