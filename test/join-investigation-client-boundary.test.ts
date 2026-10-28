import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const webRequire = createRequire(join(root, "web/package.json"));
const { compile } = webRequire("svelte/compiler");

// Admin pages do not hydrate, but Kit still inventories their browser modules.
// Compile and bundle the actual list/detail views: request normalization and
// byte-bound navigation construction belong to the admitted server load, not
// to those modules. The route/SSR suites separately pin every emitted href.
describe("join investigation browser boundary", () => {
  it.each(["", "/[id]"])("does not ship context encoders in the %s view", async (suffix) => {
    const result = await build({
      entryPoints: [join(root, `web/src/routes/admin/join-attempts${suffix}/+page.svelte`)],
      absWorkingDir: root,
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      minify: true,
      tsconfigRaw: { compilerOptions: {} },
      nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
      alias: { "#lib": join(root, "web/src/lib") },
      plugins: [
        {
          name: "join-investigation-client-boundary",
          setup(plugin) {
            plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
              contents: compile(readFileSync(path, "utf8"), {
                generate: "client",
                dev: false,
                filename: path,
              }).js.code,
              loader: "js",
              resolveDir: dirname(path),
            }));
          },
        },
      ],
    });
    const code = result.outputFiles[0]!.text;
    expect(code).toContain("Join attempt");
    for (const serverOnly of [
      "TextEncoder",
      "from_outcome",
      "from_page",
      "URLSearchParams",
      "Not recorded",
      "not verified anonymity",
    ]) {
      expect(code.includes(serverOnly), serverOnly).toBe(false);
    }
  });
});
