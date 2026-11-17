// Hash explicit reviewed inputs from the evaluated checkout. These hashes do
// not authenticate the checkout, producer, report, or CI run by themselves.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function routeEvidenceInputHashes(checkoutRoot, inputs) {
  if (typeof checkoutRoot !== "string" || !isAbsolute(checkoutRoot))
    throw new Error("route evidence inputs refused: invalid root");
  if (!Array.isArray(inputs) || inputs.length === 0)
    throw new Error("route evidence inputs refused: empty inputs");
  const root = realpathSync(checkoutRoot);
  const seen = new Set();
  const hashes = [];
  for (const path of inputs) {
    if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\"))
      throw new Error("route evidence inputs refused: invalid path");
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (rel !== path || rel === ".." || rel.startsWith(`..${sep}`))
      throw new Error("route evidence inputs refused: noncanonical path");
    if (seen.has(path)) throw new Error("route evidence inputs refused: duplicate path");
    seen.add(path);
    if (realpathSync(absolute) !== absolute)
      throw new Error("route evidence inputs refused: aliased input");
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("route evidence inputs refused: aliased or non-file input");
    hashes.push({
      path,
      sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    });
  }
  return hashes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The reviewed paths are supplied independently of the evidence being checked.
export function assertRouteEvidenceInputHashes(checkoutRoot, reviewedPaths, supplied) {
  const actual = routeEvidenceInputHashes(checkoutRoot, reviewedPaths);
  if (!Array.isArray(supplied) || supplied.length !== actual.length)
    throw new Error("route evidence inputs refused: incomplete hashes");
  const byPath = new Map();
  for (const entry of supplied) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      byPath.has(entry.path)
    )
      throw new Error("route evidence inputs refused: malformed hashes");
    byPath.set(entry.path, entry.sha256);
  }
  if (actual.some(({ path, sha256 }) => byPath.get(path) !== sha256))
    throw new Error("route evidence inputs refused: hash mismatch");
}
