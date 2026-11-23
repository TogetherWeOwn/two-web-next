export { parse as parseRenderedPage } from "parse5";

/** @typedef {import("parse5").DefaultTreeAdapterMap["node"]} Node */
/** @typedef {import("parse5").DefaultTreeAdapterMap["element"]} Element */

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const NON_RENDERING_TAGS = new Set(["template", "script", "style", "noscript"]);

// Static HTML check. Playwright checks visibility with the full CSS cascade.
const INLINE_DISPLAY_NONE = /(?:^|;)\s*display\s*:\s*none\s*(?:!\s*important\s*)?(?:;|$)/i;
const CSS_COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;

/** @param {Element} element @param {string} name */
export function renderedAttribute(element, name) {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

/** @param {Element} element */
function isInactive(element) {
  if (NON_RENDERING_TAGS.has(element.tagName)) return true;
  if (renderedAttribute(element, "hidden") !== undefined) return true;
  if (renderedAttribute(element, "inert") !== undefined) return true;
  // Drop comments without joining tokens. Quoted strings cannot contain declarations.
  const style = renderedAttribute(element, "style") ?? "";
  return INLINE_DISPLAY_NONE.test(
    style.replace(CSS_COMMENT_OR_STRING, (part) => (part.startsWith("/*") ? " " : '""')),
  );
}

/** @param {Node} root */
function* renderedNodes(root) {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.nodeName === "#comment" || ("tagName" in node && isInactive(node))) continue;
    yield node;
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        pending.push(node.childNodes[index]);
      }
    }
  }
}

/**
 * Match HTML elements in document order. `role` matches the explicit role attribute.
 * @param {Node} root
 * @param {{ tag?: string, id?: string, role?: string }} selector
 */
export function* renderedElements(root, { tag, id, role }) {
  for (const node of renderedNodes(root)) {
    if (!("tagName" in node) || node.namespaceURI !== HTML_NAMESPACE) continue;
    if (tag !== undefined && node.tagName !== tag) continue;
    if (id !== undefined && renderedAttribute(node, "id") !== id) continue;
    if (role !== undefined && renderedAttribute(node, "role") !== role) continue;
    yield node;
  }
}

/** @param {Node} root */
export function renderedText(root) {
  let text = "";
  for (const node of renderedNodes(root)) {
    if ("value" in node) text += node.value;
  }
  return text;
}
