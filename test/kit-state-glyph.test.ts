import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { html, parseFragment } from "parse5";
import { describe, expect, it } from "vitest";
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

describe("state glyph server rendering", () => {
  it("hides the glyph at the compact layout breakpoint", () => {
    const source = readFileSync(join(root, "web/src/lib/StateGlyph.svelte"), "utf8");
    expect(source).toMatch(
      /@media\s*\(max-width:\s*820px\)\s*\{\s*\.state-glyph\s*\{\s*display:\s*none/,
    );
  });

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
      const ring = { tag: "circle", radius: "7", fill: "none" };
      const expectedShapes = {
        upcoming: [ring],
        live: [{ tag: "path", radius: undefined, fill: "currentColor" }, ring],
        mine: [ring, { tag: "circle", radius: "3", fill: "currentColor" }],
        past: [{ tag: "circle", radius: "8", fill: "currentColor" }],
      };
      for (const [state, expected] of Object.entries(expectedShapes)) {
        for (const scriptingEnabled of [true, false]) {
          const glyphs = elements(parseFragment(states[state]!, { scriptingEnabled })).filter(
            (node) => node.namespaceURI === html.NS.SVG && node.tagName === "svg",
          );
          expect(glyphs, state).toHaveLength(1);
          const glyph = glyphs[0]!;
          expect(attr(glyph, "aria-hidden"), state).toBe("true");
          expect(attr(glyph, "focusable"), state).toBe("false");
          const shapes = elements(glyph).slice(1);
          const names = shapes.map((node) => node.tagName);
          const radii = shapes.map((node) => attr(node, "r"));
          const fills = shapes.map((node) => attr(node, "fill"));
          expect(
            shapes.map((node) => node.namespaceURI),
            state,
          ).toEqual(expected.map(() => html.NS.SVG));
          expect(names, state).toEqual(expected.map(({ tag }) => tag));
          expect(radii, state).toEqual(expected.map(({ radius }) => radius));
          expect(fills, state).toEqual(expected.map(({ fill }) => fill));
          if (state === "past") expect(attr(glyph, "fill")).not.toBe("none");
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);
});
