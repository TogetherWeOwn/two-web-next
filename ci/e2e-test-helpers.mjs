// Dependency inventory for change-scope.sh. Runs before npm ci, so use only
// Node built-ins. Conservatively follow quoted relative paths, not JS syntax:
// this covers multiline imports, re-exports, require and literal import(`...`).
// A computed import()/require() path, or a multiline relative template, fails
// closed. An import-like comment/string may select extra smoke, never suppress it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

const search = spawnSync("git", ["grep", "-lz", "-e", "", "--", "e2e/", "test/"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (search.error || (search.status !== 0 && search.status !== 1)) {
  throw new Error("Cannot search the e2e helper tree");
}
const files = new Set(search.stdout.split("\0").filter(Boolean));
const pending = [...files].filter((path) => path.startsWith("e2e/"));
const visited = new Set();
const helpers = new Set();
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts"];

// Linear scan past whitespace, comments and closing parens; true when a `+`
// follows. Hand-rolled because an alternation regex over the same trivia
// backtracks exponentially on repeated `//`.
function followedByPlus(source, from) {
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "+") return true;
    if (ch === ")" || /\s/.test(ch)) {
      i += 1;
    } else if (source.startsWith("//", i)) {
      const nl = source.indexOf("\n", i);
      if (nl === -1) return false;
      i = nl + 1;
    } else if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else {
      return false;
    }
  }
  return false;
}

while (pending.length) {
  const file = pending.pop();
  if (visited.has(file)) continue;
  visited.add(file);
  const source = readFileSync(file, "utf8");
  if (
    /\b(?:import|require)\s*\((?!\s*(?:"[^"\\\r\n]*"|'[^'\\\r\n]*'|`[^`\\$\r\n]*`)\s*\))/.test(
      source,
    )
  ) {
    throw new Error("Cannot resolve a computed module import");
  }
  if (/`\.\.?\/[^`\n]*\n/.test(source)) throw new Error("Cannot resolve a multiline helper path");
  // No line or keyword restriction: the specifier may follow `from` on the
  // next line. Deliberately include import-like comments rather than trying
  // to lex JS with a regex and accidentally hiding real imports.
  for (const match of source.matchAll(/(["'`])(\.\.?\/[^"'`\r\n]*)\1/g)) {
    const specifier = match[2];
    const target = posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\/+$/, "");
    if (/[\\$]/.test(specifier)) {
      // Don't infer variable dataflow. Opaque test paths, escaped paths, or
      // opaque relative paths in a file with dynamic imports all run smoke.
      // A plain file-reader template (no dynamic import) is not a module path.
      if (
        /\\/.test(specifier) ||
        /^test(\/|$)/.test(target) ||
        /\b(?:import|require)\s*\(/.test(source)
      ) {
        throw new Error("Cannot resolve an escaped or computed helper import");
      }
      continue;
    }
    if (!/^(test|e2e)(\/|$)/.test(target)) continue;
    // A relative prefix may feed import(variable) later, so don't infer a
    // complete dependency from a concatenated string, even outside import().
    if (followedByPlus(source, match.index + match[0].length)) {
      throw new Error("Cannot resolve a concatenated helper path");
    }
    // Include all possible source counterparts, even absent ones: deleted or
    // renamed helpers must still run smoke against their old import path.
    const stem = target.replace(/(?:\.d)?\.(?:[cm]?[jt]sx?)$/, "");
    const candidates = [target, stem, ...extensions.map((ext) => stem + ext)];
    candidates.push(...extensions.map((ext) => `${target}/index${ext}`));
    for (const path of candidates) {
      if (path.startsWith("test/")) helpers.add(path);
      if (files.has(path) && !visited.has(path)) pending.push(path);
    }
  }
}
console.log([...helpers].sort().join("\n"));
