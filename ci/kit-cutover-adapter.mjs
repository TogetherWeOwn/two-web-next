import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { build } from "esbuild";

// The generated adapter resolves SvelteKit server chunks from its build tree.
// Inline that graph before parity so the exact two-module upload can start
// without the rest of the checkout.
export async function bundleCutoverAdapter(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd"],
    mainFields: ["module", "main"],
    alias: Object.fromEntries(builtinModules.map((id) => [id, id.replace(/^(node:)?/, "node:")])),
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
    metafile: true,
  });
  assert.equal(result.outputFiles.length, 1, "cutover adapter must build one runtime module");
  for (const output of Object.values(result.metafile.outputs)) {
    assert.ok(
      output.imports.every(({ path }) => /^(?:cloudflare|node):/.test(path)),
      "cutover adapter still depends on a non-runtime module",
    );
  }
  return result.outputFiles[0].contents;
}
