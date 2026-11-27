import type { DefaultTreeAdapterTypes } from "parse5";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type Attributes = Record<string, string>;

export function parseRenderedPage(
  html: string,
  options?: { scriptingEnabled?: boolean },
): DefaultTreeAdapterTypes.Document;
export function renderedAttribute(node: Element, name: string): string | undefined;
export function elements(root: Node, tag?: string, attributes?: Attributes): Element[];
export function element(root: Node, tag: string, attributes?: Attributes): Element;
export function text(node: Node): string;
export function rowCells(row: Element): Element[];
export function documentElements(root: Node, tag: string): Element[];
export function fallbackText(root: Node): string;
export function childText(element: Element): string;
export function responseValues(root: Node, html: string): string[];
