export { parse as parseRenderedPage } from "parse5";

/** @typedef {import("parse5").DefaultTreeAdapterMap["node"]} Node */
/** @typedef {import("parse5").DefaultTreeAdapterMap["element"]} Element */

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const NON_RENDERING_TAGS = new Set(["template", "script", "style", "noscript", "title"]);

const CSS_COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;
const CSS_BOUNDARY = /\\[\s\S]|[()[\]{};]/g;
const CSS_BLOCK_END = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);
const DISPLAY_DECLARATION = /^\s*display\s*:\s*([a-z-]+(?:\s+[a-z-]+)*)\s*(!\s*important)?\s*$/i;
const DISPLAY_KEYWORDS = new Set(
  (
    "none contents block inline run-in flow flow-root table flex grid ruby math list-item " +
    "inline-block inline-table inline-flex inline-grid table-row-group table-header-group " +
    "table-footer-group table-row table-cell table-column-group table-column table-caption " +
    "ruby-base ruby-text ruby-base-container ruby-text-container " +
    "inherit initial unset revert revert-layer"
  ).split(" "),
);
const DISPLAY_OUTSIDE = new Set(["block", "inline", "run-in"]);
const DISPLAY_INSIDE = new Set(["flow", "flow-root", "table", "flex", "grid", "ruby", "math"]);

// Resolve literal inline display declarations. Playwright checks computed visibility.
function hasInlineDisplayNone(style) {
  // Keep declaration separators inside comments and strings out of the scan.
  const source = style.replace(CSS_COMMENT_OR_STRING, (part) =>
    part.startsWith("/*") ? " " : '""',
  );
  let start = 0;
  const blockEnds = [];
  let important = false;
  let hidden = false;
  for (const boundary of (source + ";").matchAll(CSS_BOUNDARY)) {
    const [token] = boundary;
    const end = CSS_BLOCK_END.get(token);
    if (end) blockEnds.push(end);
    else if (token === blockEnds.at(-1)) blockEnds.pop();
    if (token !== ";" || blockEnds.length > 0) continue;
    const [, value, priority] = DISPLAY_DECLARATION.exec(source.slice(start, boundary.index)) ?? [];
    start = boundary.index + 1;
    if (!value || (important && !priority)) continue;
    const [first, second, extra] = value.toLowerCase().split(/\s+/);
    const valid = second
      ? !extra &&
        ((DISPLAY_OUTSIDE.has(first) && DISPLAY_INSIDE.has(second)) ||
          (DISPLAY_INSIDE.has(first) && DISPLAY_OUTSIDE.has(second)))
      : DISPLAY_KEYWORDS.has(first);
    if (!valid) continue;
    important = Boolean(priority);
    hidden = first === "none";
  }
  return hidden;
}

/** @param {Element} element @param {string} name */
export function renderedAttribute(element, name) {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

/** @param {Element} element */
function isInactive(element) {
  if (NON_RENDERING_TAGS.has(element.tagName)) return true;
  if (element.namespaceURI === SVG_NAMESPACE && ["desc", "metadata"].includes(element.tagName))
    return true;
  if (renderedAttribute(element, "hidden") !== undefined) return true;
  if (renderedAttribute(element, "inert") !== undefined) return true;
  const style = renderedAttribute(element, "style");
  return style !== undefined && hasInlineDisplayNone(style);
}

/** @param {Node} root */
function* renderedNodes(root, includeInactive = false) {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.nodeName === "#comment" || (!includeInactive && "tagName" in node && isInactive(node)))
      continue;
    yield node;
    if (includeInactive && "tagName" in node && node.tagName === "template" && "content" in node)
      pending.push(node.content);
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        pending.push(node.childNodes[index]);
      }
    }
  }
}

/**
 * Match elements in document order. `tag` is an HTML tag and `role` is an explicit attribute.
 * @param {Node} root
 * `includeInactive` also searches hidden markup and template contents for absence checks.
 * @param {{ tag?: string, id?: string, role?: string, includeInactive?: boolean }} selector
 */
export function* renderedElements(root, { tag, id, role, includeInactive = false }) {
  for (const node of renderedNodes(root, includeInactive)) {
    if (!("tagName" in node)) continue;
    if (tag !== undefined && (node.namespaceURI !== HTML_NAMESPACE || node.tagName !== tag))
      continue;
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
