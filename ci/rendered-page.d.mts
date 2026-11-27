import type { DefaultTreeAdapterTypes as DOM } from "parse5";

export { parse as parseRenderedPage } from "parse5";

export function renderedAttribute(element: DOM.Element, name: string): string | undefined;
export function renderedElements(
  root: DOM.Node,
  selector: { tag?: string; id?: string; role?: string },
): Generator<DOM.Element>;
export function renderedText(root: DOM.Node): string;
