import { createRequire } from "node:module";
import type { DefaultTreeAdapterMap } from "parse5";

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
type Root = Node | string | undefined;
type Selector = { tag?: string; id?: string; role?: string };
type Attributes = Record<string, string>;

export const {
  parseRenderedPage: parse,
  renderedAttribute: attr,
  renderedElements,
  renderedText,
} = createRequire(import.meta.url)("../../ci/rendered-page.mjs") as {
  parseRenderedPage: (
    html: string,
    options?: { scriptingEnabled?: boolean },
  ) => DefaultTreeAdapterMap["document"];
  renderedAttribute: (element: Element, name: string) => string | undefined;
  renderedElements: (root: Node, selector: Selector) => Iterable<Element>;
  renderedText: (root: Node) => string;
};

const matches = (node: Element, attrs: Attributes) =>
  Object.entries(attrs).every(([name, value]) => attr(node, name) === value);

export function all(root: Root, tag?: string, attrs: Attributes = {}) {
  if (!root) return [];
  return [...renderedElements(typeof root === "string" ? parse(root) : root, { tag })].filter(
    (node) => matches(node, attrs),
  );
}

export const find = (root: Root, tag?: string, attrs?: Attributes) => all(root, tag, attrs)[0];

export const testId = (root: Root, id: string) => find(root, undefined, { "data-testid": id });
export const link = (root: Root, href: string) => find(root, "a", { href });
export const testLink = (root: Root, id: string, href: string) =>
  find(root, "a", { "data-testid": id, href });
export const text = (node: Node | undefined) =>
  node ? renderedText(node).replace(/\s+/g, " ").trim() : undefined;

// Absence checks must cover markup sent to the browser, including inert content.
function* sourceTree(root: Node, includeTemplates: boolean): Iterable<Element> {
  if ("tagName" in root) yield root;
  if (includeTemplates && "content" in root) yield* sourceTree(root.content, includeTemplates);
  if ("childNodes" in root) {
    for (const child of root.childNodes) yield* sourceTree(child, includeTemplates);
  }
}

export function sourceElements(
  root: Root,
  tag?: string,
  attrs: Attributes = {},
  includeTemplates = true,
) {
  if (!root) return [];
  const tree =
    typeof root === "string" ? parse(root, { scriptingEnabled: !includeTemplates }) : root;
  return [...sourceTree(tree, includeTemplates)].filter(
    (node) =>
      (tag === undefined ||
        (node.tagName === tag && node.namespaceURI === "http://www.w3.org/1999/xhtml")) &&
      matches(node, attrs),
  );
}

export const sourceTestId = (root: Root, id: string) =>
  sourceElements(root, undefined, { "data-testid": id })[0];

export const withClass = (root: Root, tag: string, name: string) =>
  all(root, tag).find((node) => attr(node, "class")?.split(/\s+/).includes(name));
