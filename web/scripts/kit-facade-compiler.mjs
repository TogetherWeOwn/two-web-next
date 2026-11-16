// Inactive compiler helper; the installer owns all filesystem changes.
// Design credit: Rick7C2, draft #2092, eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const facadePath = fileURLToPath(new URL("../../src/kit-worker-facade.ts", import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// The companion name is fixed so the generated entry and adapter can be placed
// together without rewriting either output. Adapter source is parsed, not run.
export async function compileKitFacade(adapterSource) {
  const parsed = await build({
    stdin: { contents: adapterSource, loader: "js", sourcefile: "adapter.js" },
    bundle: false,
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const [adapterInput] = Object.values(parsed.metafile.inputs);
  const [adapterOutput] = Object.values(parsed.metafile.outputs);
  // CommonJS entries can acquire a synthetic default during ESM conversion.
  if (adapterInput.format !== "esm" || !adapterOutput.exports.includes("default")) {
    throw new Error("kit facade compiler: adapter must export default");
  }

  const result = await build({
    stdin: {
      contents: `import adapter from "./kit-adapter.js";\nimport { createKitWorkerFacade } from ${JSON.stringify(facadePath)};\nexport default createKitWorkerFacade(adapter);\n`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "js",
      sourcefile: "kit-facade-entry.js",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["./kit-adapter.js"],
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles[0].text;
  return { output, adapterSha256: sha256(adapterSource), facadeSha256: sha256(output) };
}
