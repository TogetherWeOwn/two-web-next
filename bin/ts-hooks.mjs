// Minimal ESM resolve hook: retry an unresolved extensionless relative
// specifier with `.ts` appended. Absolute/package specifiers pass through
// untouched — a real miss still throws rather than resolving somewhere odd.
// Only used by bin/*.mjs operator scripts running under plain node (which
// strips types but keeps strict ESM resolution); vitest resolves these
// imports itself and never loads this file.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (relative && !specifier.endsWith(".ts") && !specifier.includes("\0")) {
      return await nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
