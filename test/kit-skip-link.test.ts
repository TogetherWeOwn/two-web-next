import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { html, parseFragment } from "parse5";
import { expect, it } from "vitest";
import { attr, elements } from "./helpers/kit-edit-controls";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => {
    js: { code: string };
  };
};

it("renders a native skip link to the main landmark", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-skip-link-"));
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "bundle.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import SkipLink from ${JSON.stringify(join(root, "web/src/lib/SkipLink.svelte"))};
export const body = render(SkipLink).body;`,
    );
    await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      absWorkingDir: root,
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      plugins: [
        {
          name: "skip-link-ssr",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, (args) => ({
              contents: compile(readFileSync(args.path, "utf8"), {
                generate: "server",
                dev: false,
                filename: args.path,
              }).js.code,
              loader: "js",
              resolveDir: dirname(args.path),
            }));
          },
        },
      ],
    });
    const { body } = (await import(pathToFileURL(outfile).href)) as { body: string };
    for (const scriptingEnabled of [true, false]) {
      const links = elements(parseFragment(body, { scriptingEnabled })).filter(
        (node) => node.tagName === "a",
      );
      expect(links).toHaveLength(1);
      const link = links[0]!;
      expect(link.namespaceURI).toBe(html.NS.HTML);
      expect(attr(link, "href")).toBe("#main");
      expect(link.childNodes).toMatchObject([{ nodeName: "#text", value: "Skip to content" }]);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
