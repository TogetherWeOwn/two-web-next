import { build } from "esbuild";
import { resolve } from "node:path";

// Replace only this production reader in the temporary audit bundle, not pages
// or routes. Wrangler and route discovery consume the exact same bundle.
export async function buildAuditWorker(outfile) {
  const counts = resolve("src/counts.ts");
  return build({
    entryPoints: ["ci/a11y-worker.ts"], bundle: true, packages: "external",
    platform: "node", format: "esm", outfile, metafile: true,
    plugins: [{
      name: "isolated-audit-counts",
      setup(build) {
        build.onResolve({ filter: /counts$/ }, ({ path, resolveDir }) => {
          if (resolve(resolveDir, `${path}.ts`) === counts) return { path: resolve("ci/a11y-read-models.ts") };
        });
      },
    }],
  });
}
