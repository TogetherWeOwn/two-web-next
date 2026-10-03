// Directive names, not values: max-image-preview: none does not mean noindex.
// Source: https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag
const valuedDirectives = new Set([
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "unavailable_after",
]);

export function headerIndexingRules(header) {
  const rules = [];
  for (const field of Array.isArray(header) ? header : [header ?? ""]) {
    let crawler = "*";
    for (let token of field.toLowerCase().split(",")) {
      token = token.trim();
      const scope = token.match(/^([\w*-]+):\s*(.*)$/);
      if (scope && !valuedDirectives.has(scope[1])) {
        crawler = scope[1];
        token = scope[2];
      }
      if (["noindex", "none"].includes(token)) rules.push({ crawler, source: "header" });
    }
  }
  return rules;
}
