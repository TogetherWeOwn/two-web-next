// Parse only the generator's literal or fixed-token initializer, never code.
export function parseLeafModule(source) {
  const match =
    /^(?:\/\/[^\n]*\n)*export const LEAF_CRITICAL_CSS: string =\n {2}("(?:[^"\\\n\r]|\\.)*")(\.split\("~"\)\.join\("\.base-theme"\))?;\nexport const LEAF_CRITICAL_CSS_SHA256: string = "([A-Za-z0-9+/]{43}=)";\n$/.exec(
      source,
    );
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return { css: match[2] ? value.split("~").join(".base-theme") : value, sha256: match[3] };
  } catch {
    return null;
  }
}
