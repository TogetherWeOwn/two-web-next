// Mask component CSS without losing the native Tailwind scanner's variable uses.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "svelte/compiler";

const web = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(web, "package.json"));
export const MAX_SOURCE_BYTES = 1024 * 1024;

/** Actual compiler style ranges as [start, end) UTF-16 offsets. */
export function styleRanges(source) {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error("tailwind-projection: source byte limit");
  }
  const ast = parse(source, { modern: true });
  return ast.css ? [[ast.css.start, ast.css.end]] : [];
}

let oxide;
function loadOxide() {
  if (oxide) return oxide;
  let dir = dirname(require.resolve("@tailwindcss/oxide"));
  const named = () => {
    try {
      return (
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@tailwindcss/oxide"
      );
    } catch {
      return false;
    }
  };
  while (!named()) {
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("tailwind-projection: @tailwindcss/oxide package not found");
    dir = parent;
  }
  const installed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
  const lock = JSON.parse(readFileSync(join(web, "package-lock.json"), "utf8"));
  const pinned = lock.packages?.["node_modules/@tailwindcss/oxide"]?.version;
  if (!pinned || installed !== pinned) {
    throw new Error(`tailwind-projection: oxide ${installed} does not match lockfile ${pinned}`);
  }
  oxide = require("@tailwindcss/oxide");
  return oxide;
}

/** Fresh scanner per call; no cached candidates survive between files. */
function candidates(content) {
  const { Scanner } = loadOxide();
  return new Set(new Scanner({}).scanFiles([{ content, extension: "svelte" }]));
}

/** Mask compiler-identified styles and retain native scanner variable uses. */
export function projectSvelte(source) {
  let out = "";
  let at = 0;
  for (const [start, end] of styleRanges(source)) {
    if (start < at || end > source.length) throw new Error("tailwind-projection: bad style range");
    out += source.slice(at, start) + source.slice(start, end).replace(/[^\r\n]/g, " ");
    at = end;
  }
  out += source.slice(at);
  const variables = [...candidates(source)].filter((name) => name.startsWith("--")).sort();
  return `${out}\n${variables.join("\n")}\n`;
}

/** Projection may remove style-derived candidates but must not invent candidates or lose variables. */
export function assertProjection(source, projected) {
  const original = candidates(source);
  const result = candidates(projected);
  for (const token of result) {
    if (!original.has(token)) throw new Error(`tailwind-projection: invented candidate ${token}`);
  }
  for (const token of original) {
    if (token.startsWith("--") && !result.has(token)) {
      throw new Error(`tailwind-projection: missing variable ${token}`);
    }
  }
}
