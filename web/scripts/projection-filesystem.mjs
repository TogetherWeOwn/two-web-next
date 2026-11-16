import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Compare pathnames, not filesystem identities or mount aliases. */
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
    missing.push(relative(parent, current));
    current = parent;
  }
}

/**
 * Inspect resolved pathnames for diagnostics only. Mount aliases may expose the
 * same objects under distinct names; success never authorizes filesystem mutation.
 * Protected paths must resolve. Parent components are refused because lexical
 * normalization can change their meaning when an earlier component is a symlink.
 */
export function inspectProjectionPaths(output, protectedPaths) {
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
  return { output: physical, protectedPaths: protectedPaths.map((path) => realpathSync(path)) };
}
