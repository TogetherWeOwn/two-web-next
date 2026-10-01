/** XML 1.0 §2.2: replace forbidden characters and lone surrogates with U+FFFD.
 * Unicode mode preserves valid surrogate pairs, including legal astral noncharacters.
 * Then escape markup with the existing htmlspecialchars(ENT_QUOTES | ENT_XML1) spelling.
 */
export function rssXml(v: string): string {
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\u{FFFE}\u{FFFF}]/gu, "�")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
