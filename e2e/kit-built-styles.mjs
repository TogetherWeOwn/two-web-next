import { readFileSync } from "node:fs";

// Read only SvelteKit's emitted stylesheet literal, not its server module:
// importing that module executes the root load's cloudflare:workers graph.
// Fail closed if the generated format changes or the fixture would be unstyled.
export async function builtNodeStyles(path) {
  const source = readFileSync(path, "utf8");
  const literal = source.match(/\bexport const stylesheets\s*=\s*(\[[^\]]*\]);/)?.[1];
  if (!literal) throw new Error("Kit node stylesheet metadata is missing");
  const styles = JSON.parse(literal);
  if (
    !Array.isArray(styles) ||
    styles.length === 0 ||
    styles.some(
      (href) => typeof href !== "string" || !/^_app\/immutable\/assets\/[\w.-]+\.css$/.test(href),
    )
  ) {
    throw new Error("Kit node stylesheet metadata is invalid");
  }
  return styles;
}
