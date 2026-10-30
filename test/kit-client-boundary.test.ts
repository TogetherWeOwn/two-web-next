import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRequire = createRequire(new URL("../web/package.json", import.meta.url).href);
const { compile } = webRequire("svelte/compiler");

// Compile the actual client components: importing a display helper from a
// server-renderer barrel must not retain DB contexts or Node-only side effects.
// platform: browser deliberately refuses builtins rather than hiding them
// behind Vite's empty browser-external stub.
describe("Kit client presentation boundary", () => {
  for (const component of ["ProfileView", "EventCard"]) {
    it(`${component} bundles for browsers without the server rendering graph`, async () => {
      const result = await build({
        absWorkingDir: root,
        entryPoints: [`web/src/lib/${component}.svelte`],
        bundle: true,
        platform: "browser",
        format: "esm",
        write: false,
        metafile: true,
        logLevel: "silent",
        jsx: "automatic",
        jsxImportSource: "hono/jsx",
        nodePaths: [resolve(root, "web/node_modules")],
        plugins: [
          {
            name: "client-presentation-boundary",
            setup(plugin) {
              plugin.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
                contents: compile(readFileSync(path, "utf8"), {
                  filename: path,
                  generate: "client",
                  dev: false,
                }).js.code,
                loader: "js",
                resolveDir: dirname(path),
              }));
            },
          },
        ],
      });
      const inputs = Object.keys(result.metafile.inputs);
      expect(inputs.some((path) => path.endsWith(`${component}.svelte`))).toBe(true);
      expect(
        inputs.filter((path) =>
          /(?:^|\/)src\/(?:db\/|member-reads\.|pages\.|profiles\/(?:pages\.|stats\.)|events\/pages)/.test(
            path,
          ),
        ),
      ).toEqual([]);
      expect(result.outputFiles[0]!.text).not.toContain("AsyncLocalStorage");
    });
  }
});
