import type { DefaultTreeAdapterMap } from "parse5";

export { parse as parseRenderedPage } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

export function renderedAttribute(element: Element, name: string): string | undefined;
export function renderedElements(
  root: Node,
  selector: { tag?: string; id?: string; role?: string },
): IterableIterator<Element>;
export function renderedText(root: Node): string;
