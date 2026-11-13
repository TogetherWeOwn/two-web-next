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

describe("state glyph server rendering", () => {
  it("renders distinct decorative shapes for all four states", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kit-state-glyph-"));
    try {
      const entry = join(scratch, "entry.mjs");
      const outfile = join(scratch, "bundle.mjs");
      writeFileSync(
        entry,
        `import { render } from "svelte/server";
import Glyph from ${JSON.stringify(join(root, "web/src/lib/StateGlyph.svelte"))};
export const states = Object.fromEntries(["upcoming", "live", "mine", "past"].map(state => [state, render(Glyph, { props: { state } }).body]));`,
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
            name: "state-glyph-ssr",
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
      const { states } = (await import(pathToFileURL(outfile).href)) as {
        states: Record<string, string>;
      };
      for (const state of Object.values(states)) {
        expect(state).toContain('aria-hidden="true"');
        expect(state).toContain('focusable="false"');
      }
      expect(states.upcoming).toContain('fill="none"');
      expect(states.upcoming).not.toContain("<path");
      expect(states.live).toContain("<path");
      expect(states.mine).toContain('r="3"');
      expect(states.past).toContain('fill="currentColor"');
      expect(states.past).not.toContain('fill="none"');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);
});
