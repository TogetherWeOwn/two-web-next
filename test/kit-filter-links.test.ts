import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import type { DefaultTreeAdapterMap, parse } from "parse5";
import { expect, it } from "vitest";
import { elements } from "./helpers/kit-edit-controls";

const root = fileURLToPath(new URL("../", import.meta.url));
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
// The shared JavaScript helper has no TypeScript declaration on this branch.
const { parseRenderedPage, renderedAttribute, renderedElements, renderedText } = createRequire(
  import.meta.url,
)("../ci/rendered-page.mjs") as {
  parseRenderedPage: typeof parse;
  renderedAttribute: (element: Element, name: string) => string | undefined;
  renderedElements: (root: Node, selector: { tag: string }) => Iterable<Element>;
  renderedText: (root: Node) => string;
};
const webRequire = createRequire(new URL("../web/package.json", import.meta.url));
const { compile } = webRequire("svelte/compiler") as {
  compile: (
    source: string,
    options: { generate: string; dev: boolean; filename: string },
  ) => {
    js: { code: string };
  };
};

it("renders filter links with their destinations, selection and zero counts", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-filter-links-"));
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "bundle.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import Fixture from ${JSON.stringify(join(root, "test/fixtures/kit-filter-links.svelte"))};
export const body = render(Fixture).body;`,
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
          name: "filter-links-ssr",
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
    const page = parseRenderedPage(body);
    const nav = [...renderedElements(page, { tag: "nav" })].filter(
      (node) => renderedAttribute(node, "aria-label") === "Event views",
    );
    expect(nav).toHaveLength(1);
    const links = [...renderedElements(page, { tag: "a" })];
    expect(elements(page).filter((node) => node.tagName === "a")).toHaveLength(4);
    expect(links).toHaveLength(4);
    expect(nav[0] && [...renderedElements(nav[0], { tag: "a" })]).toEqual(links.slice(0, 2));
    const [upcoming, past, all, other] = links as [Element, Element, Element, Element];
    expect(renderedAttribute(upcoming, "href")).toBe("/events");
    expect(renderedAttribute(upcoming, "aria-current")).toBe("page");
    expect([...renderedElements(upcoming, { tag: "span" })].map(renderedText)).toContain("0");
    expect(renderedAttribute(past, "href")).toBe("/events/past");
    expect(renderedAttribute(past, "aria-current")).toBeUndefined();
    expect(renderedAttribute(all, "href")).toBe("/events?game=all");
    expect(renderedAttribute(all, "aria-current")).toBe("true");
    expect([...renderedElements(all, { tag: "span" })].map(renderedText)).toContain("0");
    expect(renderedAttribute(other, "href")).toBe("/events?game=other");
    expect(renderedAttribute(other, "aria-current")).toBeUndefined();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
