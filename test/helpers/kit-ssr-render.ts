import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webRequire = createRequire(join(root, "web/package.json"));
// Svelte lives in the web workspace, outside the root TypeScript configuration.
const { compile } = webRequire("svelte/compiler") as {
  compile: (source: string, options: Record<string, unknown>) => { js: { code: string } };
};

export type RenderPage = (data: Record<string, unknown>) => string;

export async function createKitSsrRenderer(componentPath: string): Promise<{
  renderPage: RenderPage;
  cleanup: () => void;
}> {
  const scratch = mkdtempSync(join(tmpdir(), "kit-ssr-render-"));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  try {
    const entry = join(scratch, "entry.mjs");
    writeFileSync(
      entry,
      `
import { render } from "svelte/server";
import Page from ${JSON.stringify(resolve(root, componentPath))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
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
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib/") },
      plugins: [
        {
          name: "kit-render-svelte-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              const { js } = compile(source, {
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
    const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
      renderPage: RenderPage;
    };
    return { renderPage: mod.renderPage, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
