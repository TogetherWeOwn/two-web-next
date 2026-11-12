// Inventory npm lifecycle hooks and locked sources without installing dependencies.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIFECYCLE = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "prepack",
  "postpack",
  "prepublishOnly",
  "publish",
  "postpublish",
];
export const REVIEWED_ROOT_HOOKS = {
  postinstall: "node ci/build-ember-tokens.mjs --check && node ci/build-leaf-css.mjs",
};
export const REVIEWED_FIRST_PARTY_GENERATORS = [
  "ci/build-ember-tokens.mjs",
  "ci/build-leaf-css.mjs",
];
const REGISTRY_PREFIX = "https://registry.npmjs.org/";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function inventoryHooks(root = repoRoot) {
  const pick = (rel) => {
    const path = join(root, rel);
    if (!existsSync(path)) return null;
    const scripts = JSON.parse(readFileSync(path, "utf8")).scripts ?? {};
    return Object.fromEntries(LIFECYCLE.filter((n) => n in scripts).map((n) => [n, scripts[n]]));
  };
  const lockBytes = readFileSync(join(root, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error("lockfile packages must be an object");
  }
  const hooks = [];
  const unpinned = [];
  const resolvedOrigins = [];
  for (const [path, meta] of Object.entries(lock.packages)) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
      throw new Error(`invalid lockfile metadata: ${path}`);
    if (path === "") continue;
    for (const field of ["hasInstallScript", "optional", "link", "inBundle"]) {
      if (field in meta && typeof meta[field] !== "boolean")
        throw new Error(`invalid ${field} value: ${path}`);
    }
    for (const field of ["version", "integrity"]) {
      if (field in meta && (typeof meta[field] !== "string" || !meta[field]))
        throw new Error(`invalid ${field} value: ${path}`);
    }
    if (meta.resolved != null && (typeof meta.resolved !== "string" || !meta.resolved)) {
      throw new Error(`invalid resolved value: ${path}`);
    }
    const resolved = meta.resolved ?? null;
    // This describes only the recorded location, not the dependency specification.
    // A direct tarball can use the npm host; alternate registries are not identifiable here.
    let origin = "unknown";
    if (meta.link) origin = "link";
    else if (meta.inBundle) origin = "bundled";
    else if (resolved?.startsWith(REGISTRY_PREFIX)) origin = "npm-registry-host";
    else if (resolved !== null) origin = "other-resolved";
    resolvedOrigins.push({ path, resolved, origin });
    if (meta.hasInstallScript) {
      hooks.push({
        path,
        version: meta.version ?? null,
        integrity: meta.integrity ?? null,
        optional: Boolean(meta.optional),
      });
    }
    if (typeof meta.resolved !== "string" || !meta.resolved.startsWith(REGISTRY_PREFIX)) {
      unpinned.push({ path, resolved: meta.resolved ?? null, link: Boolean(meta.link) });
    }
  }
  const rootHooks = pick("package.json") ?? {};
  const problems = [];
  const reviewed = JSON.stringify(REVIEWED_ROOT_HOOKS);
  if (JSON.stringify(rootHooks) !== reviewed) {
    problems.push(
      `root install hooks differ from the reviewed set ${reviewed}: ${JSON.stringify(rootHooks)}`,
    );
  }
  const rootHookGenerators = [];
  for (const [name, command] of Object.entries(rootHooks)) {
    for (const path of command.match(/\b[\w./-]+\.(?:mjs|cjs|js|ts|sh)\b/g) ?? []) {
      const isReviewed = REVIEWED_FIRST_PARTY_GENERATORS.includes(path);
      const file = join(root, path);
      rootHookGenerators.push({
        hook: name,
        path,
        reviewed: isReviewed,
        sha256: existsSync(file) ? sha256(readFileSync(file)) : null,
      });
      if (!isReviewed) problems.push(`root hook ${name} runs unreviewed script ${path}`);
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    lockSha256: sha256(lockBytes),
    rootHooks,
    rootHookGenerators,
    kitHooks: pick("web/package.json"),
    lockedDependencyHooks: hooks.sort((a, b) => a.path.localeCompare(b.path)),
    // Compatibility only: this legacy prefix filter does not classify dependency specs.
    nonRegistrySources: unpinned,
    resolvedOrigins: resolvedOrigins.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const inventory = inventoryHooks(process.argv[2] ? resolve(process.argv[2]) : repoRoot);
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    if (!inventory.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
