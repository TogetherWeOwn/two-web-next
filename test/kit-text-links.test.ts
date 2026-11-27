import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { html, parse } from "parse5";
import { expect, it } from "vitest";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";

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

it("renders each text-link variant as a native link", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "kit-text-links-"));
  try {
    const entry = join(scratch, "entry.mjs");
    const outfile = join(scratch, "bundle.mjs");
    writeFileSync(
      entry,
      `import { render } from "svelte/server";
import Fixture from ${JSON.stringify(join(root, "test/fixtures/kit-text-links.svelte"))};
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
          name: "text-links-ssr",
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
    const links = elements(parse(body)).filter(
      (node) => node.tagName === "a" && node.namespaceURI === html.NS.HTML,
    );
    expect(links).toHaveLength(3);
    const [inline, value, button] = links;
    expect(inline && attr(inline, "href")).toBe("/events");
    expect(inline && textOf(inline).trim()).toBe("Events");
    expect(value && attr(value, "href")).toBe("/members");
    expect(value && attr(value, "class")?.split(/[\t\n\f\r ]+/)).toContain("value");
    expect(value && textOf(value).trim()).toBe("Members");
    expect(button && attr(button, "href")).toBe("/join");
    expect(button && attr(button, "class")?.split(/[\t\n\f\r ]+/)).toContain("button");
    expect(button && textOf(button).trim()).toBe("Join");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
