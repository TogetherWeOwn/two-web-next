import type { DefaultTreeAdapterTypes as Dom } from "parse5";
export { parse as parseRenderedPage } from "parse5";
type Selector = { tag?: string; id?: string; role?: string; includeInactive?: boolean };
export function renderedAttribute(element: Dom.Element, name: string): string | undefined;
export function renderedElements(root: Dom.Node, selector: Selector): IterableIterator<Dom.Element>;
export function renderedText(root: Dom.Node): string;
