import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import type { DefaultTreeAdapterMap, parse } from "parse5";
import { assert, describe, expect, it } from "vitest";

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];

const { parseRenderedPage, renderedAttribute, renderedElements, renderedText } = createRequire(
  import.meta.url,
)("../ci/rendered-page.mjs") as {
  parseRenderedPage: typeof parse;
  renderedAttribute: (element: Element, name: string) => string | undefined;
  renderedElements: (root: Node, selector: { tag: string }) => Iterable<Element>;
  renderedText: (root: Node) => string;
};

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
      const sections = [...renderedElements(parseRenderedPage(html), { tag: "section" })];
      expect(sections).toHaveLength(2);
      const groups = [
        [sections[0], "h2", "Monday, 1 December", ["Community night", "Practice session"]],
        [sections[1], "h3", "Tuesday, 2 December", ["Open lobby"]],
      ] as const;
      for (const [section, headingTag, heading, events] of groups) {
        assert(section);
        const headings = [...renderedElements(section, { tag: headingTag })];
        expect(headings.map(renderedText)).toEqual([heading]);
        expect(headings[0]?.parentNode).toBe(section);
        const lists = [...renderedElements(section, { tag: "ul" })];
        expect(lists).toHaveLength(1);
        const [list] = lists;
        assert(list);
        expect(renderedAttribute(list, "role")).toBe("list");
        expect(list.parentNode).toBe(section);
        const items = [...renderedElements(list, { tag: "li" })];
        expect(items.map(renderedText)).toEqual(events);
        expect(items.every((item) => item.parentNode === list)).toBe(true);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);
});
