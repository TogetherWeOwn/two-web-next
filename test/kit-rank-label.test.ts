import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const { compile } = createRequire(new URL("../web/package.json", import.meta.url))(
  "svelte/compiler",
) as {
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
    const html = ranks[index]!;
    expect(html).toContain(name);
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/<path\b/g)).toHaveLength(5);
    expect(html.match(/<path\b[^>]*class="[^"]*\blit\b[^"]*"/g)).toHaveLength(index + 1);
    expect(html).not.toMatch(/<path\b[^>]*\sstyle=/);
  }
}, 120000);
