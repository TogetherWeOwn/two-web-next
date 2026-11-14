// Tailwind source projection for the Kit client stylesheet.
//
// Tailwind scans raw component files, so CSS inside <style> blocks (property
// names such as `filter` or `table`) yields false utility candidates. This
// module mirrors every scanned .svelte file into a generated directory with
// the compiler-identified component style blanked, and appends the native
// scanner's custom-property uses. app.css scans the mirror explicitly;
// exclusions are read from app.css and mapped back to the original sources.
//
// Every failure is fatal and removes the mirror: no stale or raw-source
// fallback. The mirror is never imported, so it stays out of the module graph.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertProjection, projectSvelte } from "./tailwind-projection-core.mjs";

export {
  assertProjection,
  MAX_SOURCE_BYTES,
  projectSvelte,
  styleRanges,
} from "./tailwind-projection-core.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const MIRROR_SOURCE = "../.svelte-kit/tailwind-projection/";
export const SOURCE_GLOB = `@source "${MIRROR_SOURCE}**/*.svelte";`;
export const MIRROR_DIRNAME = "tailwind-projection";

const posix = (path) => path.split(sep).join("/");

/** Exclusions from app.css, resolved against its directory. Fails closed. */
export function readSourceRules(css, cssDir) {
  if (css.split(SOURCE_GLOB).length !== 2) {
    throw new Error(`tailwind-projection: app.css must contain exactly one ${SOURCE_GLOB}`);
  }
  const excluded = [];
  for (const match of css.matchAll(/@source\s+not\s+([^;]*);/g)) {
    const arg = match[1].trim();
    if (/^inline\(/.test(arg)) continue; // stays in app.css as is
    const literal = /^"([^"*?{}[\]!]+)"$/.exec(arg);
    if (!literal) throw new Error(`tailwind-projection: unsupported @source not ${arg}`);
    if (!literal[1].startsWith(MIRROR_SOURCE)) {
      throw new Error(`tailwind-projection: exclusion outside mirror ${arg}`);
    }
    const suffix = literal[1].slice(MIRROR_SOURCE.length);
    const original = resolve(cssDir, suffix);
    if (!original.startsWith(resolve(cssDir) + sep)) {
      throw new Error(`tailwind-projection: invalid exclusion ${arg}`);
    }
    excluded.push(original);
  }
  return excluded;
}

const isExcluded = (file, excluded) =>
  excluded.some((path) => file === path || file.startsWith(path + sep));

function listSvelte(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`tailwind-projection: symbolic link ${path}`);
    if (entry.isDirectory()) listSvelte(path, out);
    else if (entry.isFile() && entry.name.endsWith(".svelte")) out.push(path);
  }
  return out;
}

function prune(dir, keep, root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) prune(path, keep, root);
    else if (!keep.has(path)) rmSync(path, { force: true });
  }
  if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir);
}

export const projectSource = projectSvelte;

/**
 * Rebuilds the mirror from `sourceDir` into `outputDir`. All projections are computed before any
 * write; on error the mirror is removed and the error rethrown.
 * Returns the mirror files whose bytes changed.
 */
export function regenerateProjection({
  sourceDir: srcDir,
  outputDir: mirrorDir,
  cssPath = join(srcDir, "app.css"),
}) {
  srcDir = resolve(srcDir);
  mirrorDir = resolve(mirrorDir);
  cssPath = resolve(cssPath);
  if (
    srcDir === mirrorDir ||
    srcDir.startsWith(mirrorDir + sep) ||
    mirrorDir.startsWith(srcDir + sep)
  ) {
    throw new Error("tailwind-projection: source and output must not overlap");
  }
  try {
    if (existsSync(mirrorDir) && lstatSync(mirrorDir).isSymbolicLink()) {
      throw new Error("tailwind-projection: output is a symbolic link");
    }
    const excluded = readSourceRules(readFileSync(cssPath, "utf8"), dirname(cssPath));
    const planned = new Map();
    for (const file of listSvelte(srcDir)) {
      if (isExcluded(file, excluded)) continue;
      const source = readFileSync(file, "utf8");
      const projected = projectSource(source);
      assertProjection(source, projected);
      planned.set(join(mirrorDir, relative(srcDir, file)), projected);
    }
    if (existsSync(mirrorDir)) listSvelte(mirrorDir);
    const changed = [];
    for (const [target, content] of planned) {
      if (existsSync(target) && readFileSync(target, "utf8") === content) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      changed.push(target);
    }
    if (existsSync(mirrorDir)) {
      const before = new Set(planned.keys());
      prune(mirrorDir, before, mirrorDir);
    } else mkdirSync(mirrorDir, { recursive: true });
    return { changed, files: [...planned.keys()] };
  } catch (error) {
    rmSync(mirrorDir, { recursive: true, force: true });
    throw error;
  }
}

/** Vite plugin: mirror at buildStart and on src .svelte changes in dev. */
export function tailwindProjection({ root = web } = {}) {
  root = resolve(root);
  const srcDir = join(root, "src");
  const cssPath = join(srcDir, "app.css");
  const mirrorDir = join(root, ".svelte-kit", MIRROR_DIRNAME);
  const options = { sourceDir: srcDir, outputDir: mirrorDir, cssPath };
  let failure = null;

  const run = () => {
    try {
      const result = regenerateProjection(options);
      failure = null;
      return result;
    } catch (error) {
      failure = error;
      throw error;
    }
  };

  return {
    name: "two:tailwind-projection",
    enforce: "pre",
    config(config) {
      // Preserve Vite's default sensitive-file denylist when adding the mirror.
      const deny = config.server?.fs?.deny ?? [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
      ];
      return { server: { fs: { deny: [...deny, `${posix(mirrorDir)}/**`] } } };
    },
    buildStart() {
      const { files } = run();
      for (const file of listSvelte(srcDir)) this.addWatchFile(file);
      for (const file of files) this.addWatchFile(file);
      this.addWatchFile(cssPath);
    },
    configureServer(devServer) {
      devServer.watcher.add(srcDir);
      const onChange = (path) => {
        const file = resolve(path);
        // .svelte files, a removed directory, or app.css (exclusion rules).
        if (!file.startsWith(srcDir + sep)) return;
        if (file !== cssPath && !file.endsWith(".svelte") && /\.[^/\\]+$/.test(file)) return;
        try {
          run();
        } catch (error) {
          devServer.config.logger.error(String(error?.stack ?? error));
        }
        for (const mod of devServer.moduleGraph.getModulesByFile(cssPath) ?? []) {
          void devServer.reloadModule(mod);
        }
      };
      for (const event of ["add", "change", "unlink", "unlinkDir"]) {
        devServer.watcher.on(event, onChange);
      }
    },
    transform(_code, id) {
      if (id.split("?")[0] !== cssPath) return null;
      if (failure) throw failure; // fail closed: no CSS from a stale mirror
      if (!existsSync(mirrorDir) || !statSync(mirrorDir).isDirectory()) {
        throw new Error("tailwind-projection: mirror is missing");
      }
      return null;
    },
  };
}
