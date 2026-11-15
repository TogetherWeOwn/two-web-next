import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** True for the root itself and for descendants, including filesystem roots. */
export function containsPath(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

// Resolve the existing ancestor physically, but never treat a dangling link as missing.
function physicalOutput(path) {
  let current = resolve(path);
  const missing = [];
  for (;;) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      if (current === resolve(path) && stat.isSymbolicLink()) {
        throw new Error("projection filesystem: output is a symbolic link");
      }
      return join(realpathSync(current), ...missing.reverse());
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("projection filesystem: no existing ancestor");
    missing.push(current.slice(parent.length).replace(/^[/\\]+/, ""));
    current = parent;
  }
}

function assertOrdinaryTree(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error("projection filesystem: unsafe output entry");
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    const childStat = lstatSync(child);
    if (childStat.isDirectory()) assertOrdinaryTree(child);
    else if (!childStat.isFile() || childStat.nlink !== 1)
      throw new Error("projection filesystem: unsafe output entry");
  }
}

/**
 * Validate before cleanup or writing. Callers must prevent concurrent filesystem
 * mutation between validation and use; this check is not a directory lock.
 * Every protected path must exist and resolve, including source-root symlinks.
 * Paths containing parent components are refused: lexical normalization can
 * otherwise change their meaning when an earlier component is a symlink.
 */
export function assertSafeProjectionOutput(output, protectedPaths) {
  if (!Array.isArray(protectedPaths) || protectedPaths.length === 0) {
    throw new Error("projection filesystem: protected paths required");
  }
  for (const path of [output, ...protectedPaths]) {
    if (path.split(sep).includes("..")) {
      throw new Error("projection filesystem: parent path component refused");
    }
  }
  const physical = physicalOutput(output);
  if (physical === parse(physical).root)
    throw new Error("projection filesystem: root output refused");
  for (const path of protectedPaths) {
    const protectedPath = realpathSync(path);
    if (containsPath(physical, protectedPath) || containsPath(protectedPath, physical)) {
      throw new Error("projection filesystem: output overlaps protected path");
    }
  }
  assertOrdinaryTree(resolve(output));
}
