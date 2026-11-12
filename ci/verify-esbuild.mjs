// Extracted from the asset-generation proof in #2133. This is a runtime
// compatibility check, not an attestation of package provenance or hook history.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const LOCKED_ESBUILD = "0.28.2";

// Call only on an installation from a trusted, integrity-checked lockfile with
// lifecycle scripts disabled. This check executes the installed esbuild shim.
export function verifyEsbuild(root) {
  const problems = [];
  const platform = `@esbuild/${process.platform}-${process.arch}`;
  const result = {
    ok: false,
    problems,
    version: null,
    platformPackage: platform,
    platformVersion: null,
    jsShim: false,
  };
  try {
    const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
    const lock = readJson("package-lock.json");
    const pkg = readJson("package.json");
    const locked = lock.packages?.["node_modules/esbuild"];
    const platformLock = lock.packages?.[`node_modules/${platform}`];
    if (locked?.version !== LOCKED_ESBUILD) problems.push("lock esbuild version changed");
    if (pkg.devDependencies?.esbuild !== LOCKED_ESBUILD)
      problems.push("package.json esbuild pin changed");
    if (
      locked?.optionalDependencies?.[platform] !== LOCKED_ESBUILD ||
      platformLock?.version !== LOCKED_ESBUILD ||
      platformLock.optional !== true
    ) {
      problems.push(`${platform} is not the locked optional platform package`);
    }
    result.platformVersion = readJson(`node_modules/${platform}/package.json`).version;
    if (result.platformVersion !== LOCKED_ESBUILD) problems.push(`${platform} version changed`);
    const bin = join(root, "node_modules", ".bin", "esbuild");
    const shim = realpathSync(join(root, "node_modules", "esbuild", "bin", "esbuild"));
    const digest = createHash("sha256").update(readFileSync(shim)).digest("hex");
    result.jsShim =
      realpathSync(bin) === shim &&
      digest === "183d6ead2dbc3af51aec767d5395f86fe54fbbc2d2aa8e54feb4e31d76a62f7e";
    if (!result.jsShim) problems.push("esbuild bin is not the reviewed JS shim");
    // Never execute the binary when the static prerequisites failed.
    if (problems.length) return result;
    const version = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
    result.version = version.status === 0 ? version.stdout.trim() : null;
    const minified = spawnSync(bin, ["--minify", "--loader=js"], {
      input: "let   answer = 1 ;\n",
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.version !== LOCKED_ESBUILD) problems.push(`esbuild --version is ${result.version}`);
    if (minified.status !== 0 || minified.stdout !== "let answer=1;\n") {
      problems.push("esbuild minify probe failed");
    }
  } catch (error) {
    problems.push(`esbuild proof could not read prerequisites: ${error.message}`);
  }
  result.ok = problems.length === 0;
  return result;
}
