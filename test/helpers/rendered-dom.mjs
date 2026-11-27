import { expect } from "vitest";
import { renderedAttribute, renderedElements, renderedText } from "../../ci/rendered-page.mjs";

export { parseRenderedPage, renderedAttribute } from "../../ci/rendered-page.mjs";

export function elements(root, tag, attributes = {}) {
  return [...renderedElements(root, { tag })].filter((node) =>
    Object.entries(attributes).every(([name, value]) => renderedAttribute(node, name) === value),
  );
}

export function element(root, tag, attributes = {}) {
  const matches = elements(root, tag, attributes);
  expect(
    matches,
    `Expected one rendered ${tag} matching ${JSON.stringify(attributes)}`,
  ).toHaveLength(1);
  return matches[0];
}

export function text(node) {
  return renderedText(node)
    .replace(/[ \t\n\r\f]+/g, " ")
    .trim();
}

export function rowCells(row) {
  return elements(row).filter(
    (cell) => cell.parentNode === row && (cell.tagName === "td" || cell.tagName === "th"),
  );
}

// Inspect nodes excluded from rendered queries when checking the document payload.
function* documentNodes(node) {
  yield node;
  if ("content" in node) yield* documentNodes(node.content);
  if ("childNodes" in node) {
    for (const child of node.childNodes) yield* documentNodes(child);
  }
}

export function documentElements(root, tag) {
  return [...documentNodes(root)].filter((node) => node.tagName === tag);
}

export function childText(element) {
  return element.childNodes.map((node) => node.value ?? "").join("");
}

// Payload exclusions also inspect the response because parsing discards invalid markup.
export function responseValues(root, html) {
  const decoded = [...documentNodes(root)].flatMap((node) => {
    if ("attrs" in node) return node.attrs.map(({ value }) => value);
    if ("value" in node) return [node.value];
    if ("data" in node) return [node.data];
    return [];
  });
  return [html, ...decoded];
}
