// SECRET-FREE BUILD SANDBOX ONLY. Bundling resolves candidate imports and reads
// candidate files. It must never run in an uploader/controller with credentials.
// The caller owns the isolated container, timeout, source pin and toolchain pin.
import { build } from "esbuild";
import { resolve } from "node:path";

const MAX_BYTES = 16 * 1024 * 1024;

export async function bundleCandidateKitWorker(sourceRoot) {
  try {
    if (typeof sourceRoot !== "string" || !sourceRoot.startsWith("/")) throw new Error();
    const root = resolve(sourceRoot);
    // No candidate config, plugin, CLI argument or environment build override.
    // Candidate package resolution still happens, but only inside the sandbox.
    const result = await build({
      absWorkingDir: root,
      entryPoints: ["web/.svelte-kit/cloudflare/_worker.js"],
      outfile: "worker.mjs",
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["browser", "module", "main"],
      external: ["node:*", "cloudflare:*"],
      tsconfigRaw: { compilerOptions: {} },
      define: { "process.env.NODE_ENV": '"production"' },
      sourcemap: false,
      legalComments: "none",
      logLevel: "silent",
      metafile: true,
    });
    const outputs = Object.values(result.metafile.outputs);
    if (
      result.warnings.length !== 0 ||
      result.outputFiles.length !== 1 ||
      outputs.length !== 1 ||
      outputs[0].imports.some(
        (item) => !item.external || !/^(node|cloudflare):[A-Za-z0-9_./-]+$/.test(item.path),
      ) ||
      result.outputFiles[0].contents.length === 0 ||
      result.outputFiles[0].contents.length > MAX_BYTES
    ) {
      throw new Error();
    }
    return Buffer.from(result.outputFiles[0].contents);
  } catch {
    // esbuild diagnostics contain candidate source, paths and import strings.
    throw new Error("Candidate build refused: bundle");
  }
}
