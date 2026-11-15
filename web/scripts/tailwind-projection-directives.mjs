import { resolve, sep } from "node:path";

const MIRROR_SOURCE = "../.svelte-kit/tailwind-projection/";
export const SOURCE_GLOB = `@source "${MIRROR_SOURCE}**/*.svelte";`;

/** Exclusions from app.css, mapped from the mirror to the source directory. Fails closed. */
export function readSourceRules(css, sourceDir) {
  const tokens = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@source\b/g;
  const excluded = [];
  let globCount = 0;
  for (const token of css.matchAll(tokens)) {
    if (token[0] !== "@source") continue;
    const directive = css.slice(token.index);
    if (directive.startsWith(SOURCE_GLOB)) globCount++;
    const match = /^@source\s+not\s+([^;]*);/.exec(directive);
    if (!match) {
      if (/^@source\s+not\b/.test(directive)) {
        throw new Error("tailwind-projection: unsupported @source not directive");
      }
      continue;
    }
    const arg = match[1].trim();
    if (/^inline\(/.test(arg)) continue;
    const literal = /^"([^"*?{}[\]!]+)"$/.exec(arg);
    if (!literal) throw new Error(`tailwind-projection: unsupported @source not ${arg}`);
    if (!literal[1].startsWith(MIRROR_SOURCE)) {
      throw new Error(`tailwind-projection: exclusion outside mirror ${arg}`);
    }
    const suffix = literal[1].slice(MIRROR_SOURCE.length);
    const original = resolve(sourceDir, suffix);
    if (!original.startsWith(resolve(sourceDir) + sep)) {
      throw new Error(`tailwind-projection: invalid exclusion ${arg}`);
    }
    excluded.push(original);
  }
  if (globCount !== 1) {
    throw new Error(`tailwind-projection: app.css must contain exactly one ${SOURCE_GLOB}`);
  }
  return excluded;
}
