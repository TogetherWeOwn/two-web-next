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
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertProjection, projectSvelte } from "./tailwind-projection-core.mjs";

export {
  assertProjection,
  MAX_SOURCE_BYTES,
  projectSvelte,
  styleRanges,
} from "./tailwind-projection-core.mjs";

const MIRROR_SOURCE = "../.svelte-kit/tailwind-projection/";
export const SOURCE_GLOB = `@source "${MIRROR_SOURCE}**/*.svelte";`;
export const MIRROR_DIRNAME = "tailwind-projection";

/** Exclusions from app.css, resolved against its directory. Fails closed. */
export function readSourceRules(css, cssDir) {
  const tokens = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@source\b/g;
  const excluded = [];
  let globCount = 0;
  for (const token of css.matchAll(tokens)) {
    if (token[0] !== "@source") continue;
    const directive = css.slice(token.index);
    if (directive.startsWith(SOURCE_GLOB)) globCount++;
    const match = /^@source\s+not\s+([^;]*);/.exec(directive);
    if (!match) continue;
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
  if (globCount !== 1) {
    throw new Error(`tailwind-projection: app.css must contain exactly one ${SOURCE_GLOB}`);
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

function physicalPath(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(physicalPath(parent), relative(parent, path));
  }
  return realpathSync(path);
}

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
  const physicalSource = physicalPath(srcDir);
  const physicalOutput = physicalPath(mirrorDir);
  if (
    physicalSource === physicalOutput ||
    physicalSource.startsWith(physicalOutput + sep) ||
    physicalOutput.startsWith(physicalSource + sep)
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
