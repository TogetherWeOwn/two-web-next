import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

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
    expect(body).toContain('aria-label="Event views"');
    const links = Array.from(
      body.matchAll(/<!--.*?-->|<a\b[^>]*>[\s\S]*?<\/a>/gs),
      (match) => match[0],
    ).filter((match) => match.startsWith("<a"));
    expect(links).toHaveLength(4);
    expect(links[0]).toContain('href="/events"');
    expect(links[0]).toContain('aria-current="page"');
    expect(links[0]).toMatch(/>0<\/span>/);
    expect(links[1]).toContain('href="/events/past"');
    expect(links[1]).not.toContain("aria-current");
    expect(links[2]).toContain('href="/events?game=all"');
    expect(links[2]).toContain('aria-current="true"');
    expect(links[2]).toMatch(/>0<\/span>/);
    expect(links[3]).toContain('href="/events?game=other"');
    expect(links[3]).not.toContain("aria-current");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120000);
