import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { collectImportedCss } from "./helpers/kit-imported-css";

it("retains imported CSS alongside Svelte-emitted styles in SSR fixtures", async () => {
  const root = resolve(import.meta.dirname, "..");
  const { compile } = createRequire(join(root, "web/package.json"))("svelte/compiler");
  const dir = mkdtempSync(join(tmpdir(), "kit-css-fixture-"));
  try {
    writeFileSync(join(dir, "imported.css"), ".imported-sentinel { color: red; }");
    writeFileSync(
      join(dir, "Fixture.svelte"),
      `<script>import "./imported.css";</script><p class="scoped">Fixture</p><style>.scoped { color: blue; }</style>`,
    );
    const styles: string[] = [];
    const result = await build({
      stdin: {
        contents: `import { render } from "svelte/server"; import Fixture from "./Fixture.svelte"; export const html = render(Fixture).body;`,
        resolveDir: dir,
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      nodePaths: [join(root, "web/node_modules")],
      plugins: [
        {
          name: "synthetic-ssr",
          setup(plugin) {
            collectImportedCss(plugin, styles);
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
              const { js, css } = compile(readFileSync(path, "utf8"), {
                generate: "server",
                filename: path,
              });
              if (css?.code) styles.push(css.code);
              return { contents: js.code, loader: "js", resolveDir: dirname(path) };
            });
          },
        },
      ],
    });
    const rendered = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`
    );
    const html = `<style>${styles.join("\n")}</style>${rendered.html}`;
    expect(html).toContain(".imported-sentinel { color: red; }");
    expect(html).toContain("color: blue");
    expect(html).toContain("Fixture</p>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
