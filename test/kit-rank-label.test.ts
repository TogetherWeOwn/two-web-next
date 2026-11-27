import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { html, parseFragment } from "parse5";
import { expect, it } from "vitest";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; filename: string },
  ) => { js: { code: string } };
};

it("renders five named ranks with decorative token-coloured arcs", async () => {
  const result = await build({
    stdin: {
      contents: `import { render } from 'svelte/server'; import Rank from ${JSON.stringify(join(root, "web/src/lib/RankLabel.svelte"))}; export const ranks = [1,2,3,4,5].map(rank => render(Rank, {props:{rank}}).body);`,
      resolveDir: root,
      loader: "js",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    plugins: [
      {
        name: "rank-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
            contents: compile(readFileSync(path, "utf8"), { generate: "server", filename: path }).js
              .code,
            loader: "js",
            resolveDir: dirname(path),
          }));
        },
      },
    ],
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`;
  const { ranks } = (await import(url)) as { ranks: string[] };
  for (const [index, name] of ["Prospect", "Member", "Soldier", "Veteran", "Legend"].entries()) {
    for (const scriptingEnabled of [true, false]) {
      const fragment = parseFragment(ranks[index]!, { scriptingEnabled });
      expect(textOf(fragment).trim()).toBe(name);
      const glyphs = elements(fragment).filter(
        (node) => node.namespaceURI === html.NS.SVG && node.tagName === "svg",
      );
      expect(glyphs.map((glyph) => attr(glyph, "aria-hidden"))).toEqual(["true"]);
      const paths = elements(glyphs[0]!).filter(
        (node) => node.namespaceURI === html.NS.SVG && node.tagName === "path",
      );
      expect(paths).toHaveLength(5);
      const litPaths = paths.filter((path) => {
        const classes = attr(path, "class")?.split(/[\t\n\f\r ]+/);
        return classes?.includes("lit");
      });
      expect(litPaths).toHaveLength(index + 1);
      for (const path of paths) {
        expect(attr(path, "style")).toBeUndefined();
      }
    }
  }
}, 120000);
