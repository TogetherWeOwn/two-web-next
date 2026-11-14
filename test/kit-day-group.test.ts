import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

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

describe("day group server rendering", () => {
  it("groups events in lists under the requested heading levels", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kit-day-group-"));
    try {
      const entry = join(scratch, "entry.mjs");
      const outfile = join(scratch, "bundle.mjs");
      writeFileSync(
        entry,
        `import { render } from "svelte/server";
import Fixture from ${JSON.stringify(join(root, "test/fixtures/kit-day-group.svelte"))};
export const html = render(Fixture).body;`,
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
            name: "day-group-ssr",
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
      const { html } = (await import(pathToFileURL(outfile).href)) as { html: string };
      const sections = html.match(/<section\b[^>]*>[\s\S]*?<\/section>/g) ?? [];
      expect(sections).toHaveLength(2);
      expect(sections[0]).toMatch(/<h2[^>]*>Monday, 1 December<\/h2>/);
      expect(sections[0]).toMatch(
        /<ul[^>]*>[\s\S]*<li>Community night<\/li>[\s\S]*<li>Practice session<\/li>[\s\S]*<\/ul>/,
      );
      expect(sections[1]).toMatch(/<h3[^>]*>Tuesday, 2 December<\/h3>/);
      expect(sections[1]).toMatch(/<ul[^>]*>[\s\S]*<li>Open lobby<\/li>[\s\S]*<\/ul>/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);
});
