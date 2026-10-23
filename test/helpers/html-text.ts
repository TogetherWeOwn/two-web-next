// Visible text of an HTML fragment, for test assertions on rendered pages.
// Walks `<...>` tag spans instead of regex-stripping: a
// `.replace(/<[^>]*>/g, "")` strip trips CodeQL
// js/incomplete-multi-character-sanitization, while this loop skips exactly
// the same spans (an unclosed `<` keeps the rest, like the regex).
export function stripTags(fragment: string): string {
  let out = "";
  let i = 0;
  while (i < fragment.length) {
    const lt = fragment.indexOf("<", i);
    if (lt === -1) return out + fragment.slice(i);
    out += fragment.slice(i, lt);
    const gt = fragment.indexOf(">", lt + 1);
    if (gt === -1) return out + fragment.slice(lt);
    i = gt + 1;
  }
  return out;
}
