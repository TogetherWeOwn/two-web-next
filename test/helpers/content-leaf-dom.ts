import { createRequire } from "node:module";
import type { DefaultTreeAdapterMap, parse } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Attributes = Record<string, string | null>;
const require = createRequire(import.meta.url);
const { parseRenderedPage, renderedAttribute, renderedElements, renderedText } =
  require("../../ci/rendered-page.mjs") as {
    parseRenderedPage: typeof parse;
    renderedAttribute: (element: Element, name: string) => string | undefined;
    renderedElements: (root: Node, selector: { tag?: string }) => Iterable<Element>;
    renderedText: (root: Node) => string;
  };
const { normalizeSection } = require("../../ci/kit-section-contract.mjs") as {
  normalizeSection: (html: string) => string;
};

// Script and stylesheet checks must also see elements excluded from rendered content.
function* allElements(node: Node): Generator<Element> {
  if ("tagName" in node) yield node;
  if ("childNodes" in node) for (const child of node.childNodes) yield* allElements(child);
  if ("content" in node) yield* allElements(node.content);
}

export const GUEST_JOIN = [
  "div",
  {},
  [
    ["span", { class: "account-caption" }, ["Welcome, guest"]],
    ["a", { class: "btn", href: "/join" }, ["Join with Discord"]],
  ],
];

function joinShape(node: Node): unknown {
  if ("value" in node) return node.value;
  if (!("tagName" in node)) return node.nodeName;
  const attrs = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
  const children = node.childNodes.filter(
    (child) => child.nodeName !== "#comment" && !("value" in child && child.value.trim() === ""),
  );
  return [node.tagName, attrs, children.map(joinShape)];
}

export function contentLeafDom(html: string) {
  const doc = parseRenderedPage(html, { sourceCodeLocationInfo: true });
  const all = (tag?: string, attrs: Attributes = {}, root: Node = doc) =>
    [...renderedElements(root, { tag })].filter((element) =>
      Object.entries(attrs).every(([name, expected]) => {
        const value = renderedAttribute(element, name);
        return expected === null ? value !== undefined : value === expected;
      }),
    );
  const one = (tag?: string, attrs?: Attributes) => all(tag, attrs)[0];
  const text = (node: Node | undefined) => (node ? renderedText(node) : undefined);
  // Parse noscript fallbacks as elements as well as checking the normal HTML tree.
  const noscript = parseRenderedPage(html, { scriptingEnabled: false });
  const elements = [...allElements(doc), ...allElements(noscript)];
  return {
    all,
    one,
    text,
    elements,
    attr: renderedAttribute,
    guestJoin() {
      const account = one("nav", { "aria-label": "Account" });
      const caption = account && all("span", { class: "account-caption" }, account)[0];
      return caption?.parentNode && joinShape(caption.parentNode);
    },
    // Keep the existing normalized source comparison after finding the real content node.
    markup(tag: string, attrs: Attributes) {
      const node = one(tag, attrs);
      const location = node?.sourceCodeLocation;
      if (!node || !location?.endTag)
        throw new Error(`Missing closed ${tag}: ${JSON.stringify(attrs)}`);
      return normalizeSection(
        html.slice(location.startOffset, location.endOffset).replace(/<!---->/g, ""),
      );
    },
    linksWithRel(rel: string) {
      return elements.filter(
        (node) =>
          node.tagName === "link" &&
          renderedAttribute(node, "rel")
            ?.toLowerCase()
            .split(/[\t\n\f\r ]+/)
            .includes(rel),
      );
    },
    inlineStyles() {
      return [...allElements(doc)]
        .filter(
          (node) =>
            node.tagName === "style" &&
            node.parentNode?.nodeName === "head" &&
            node.attrs.length === 0,
        )
        .map(({ sourceCodeLocation: loc }) =>
          loc?.startTag && loc.endTag
            ? html.slice(loc.startTag.endOffset, loc.endTag.startOffset)
            : undefined,
        );
    },
  };
}
