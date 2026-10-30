// Markdown owns inline/block context; parse5 owns HTML tokenizer states and
// entity consumption. Neither parser executes code or fetches destinations.
import { HtmlRenderer, Parser } from "commonmark";
import { parseFragment } from "parse5";

const BLOCKS = new Set([
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "section",
  "article",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "tr",
  "td",
  "th",
  "dt",
  "dd",
]);
const INDEPENDENT = new Set(["li", "td", "th", "dt", "dd"]);

function visibleBlocks(html) {
  const blocks = [];
  let text = "";
  let scope = null;
  let range = null;
  let textRange = null;
  const flush = () => {
    if (text.trim())
      blocks.push({
        text: text.replace(/\s+/g, " ").trim(),
        scope,
        range: range ?? textRange,
        textRange,
      });
    text = "";
    textRange = null;
  };
  const stack = [parseFragment(html, { sourceCodeLocationInfo: true })];
  while (stack.length) {
    const node = stack.pop();
    if (node.boundary) {
      flush();
      scope = node.restore;
      range = node.restoreRange;
      continue;
    }
    if (node.nodeName === "#text") {
      text += node.value;
      if (node.sourceCodeLocation) {
        const { startOffset, endOffset } = node.sourceCodeLocation;
        textRange = {
          start: Math.min(textRange?.start ?? startOffset, startOffset),
          end: Math.max(textRange?.end ?? endOffset, endOffset),
        };
      }
      continue;
    }
    if (["script", "style", "template"].includes(node.tagName)) continue;
    if (node.tagName === "br") text += " ";
    if (BLOCKS.has(node.tagName)) {
      flush();
      stack.push({ boundary: true, restore: scope, restoreRange: range });
      const location = node.sourceCodeLocation;
      range = location
        ? { start: location.startOffset, end: location.endOffset, element: true }
        : null;
      if (INDEPENDENT.has(node.tagName)) scope = node;
    }
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  flush();
  return blocks;
}

function sentences(text, separators = /(?<=[.;!?])\s+/g) {
  const result = [];
  let start = 0;
  for (const separator of text.matchAll(separators)) {
    if (/\b(?:e\.g|i\.e)\.$/i.test(text.slice(start, separator.index).trimEnd())) continue;
    result.push(text.slice(start, separator.index).trim());
    start = separator.index + separator[0].length;
  }
  if (text.slice(start).trim()) result.push(text.slice(start).trim());
  return result;
}

// Incomplete declarations may bridge layout blocks, never independent list
// items or table cells. Completed declarations do not absorb the next block.
const INCOMPLETE_DECLARATION =
  /^(?:(?:the|an?|each)\s+)?(?:event\s+)?(?:collections?|rows?|items?|results?|responses?|payloads?|pages?|DTOs?|CallToolResult|JSON)(?:\s+(?:are|is|can|may|be))*$/i;
const DECLARATION_START =
  /^(?:(?:are|is|can|may|be)\b|(?:caps?|limits?|limited|capped|bounds?|bounded|contains?|includes?|returns?|holds?|shows?)\b)/i;

export function guideStatements(markdown) {
  const tree = new Parser().parse(markdown);
  const renderer = new HtmlRenderer();
  const lines = markdown.split("\n");
  const walker = tree.walker();
  const statements = [];
  let event;
  while ((event = walker.next())) {
    const node = event.node;
    if (
      !event.entering ||
      !["paragraph", "heading", "code_block", "html_block"].includes(node.type)
    )
      continue;
    const [[firstLine, firstColumn], [lastLine, lastColumn]] = node.sourcepos;
    const sourceLines = lines.slice(firstLine - 1, lastLine);
    if (sourceLines.length === 1)
      sourceLines[0] = sourceLines[0].slice(firstColumn - 1, lastColumn);
    else {
      sourceLines[0] = sourceLines[0].slice(firstColumn - 1);
      sourceLines[sourceLines.length - 1] = sourceLines.at(-1).slice(0, lastColumn);
    }
    const source = sourceLines.join("\n").trim();
    const excerpts = new Map();
    for (const raw of sentences(source, /(?<=[.!?])(?:\s+|&(?:nbsp|#32|#x20);?)+/gi)) {
      const visible = visibleBlocks(renderer.render(new Parser().parse(raw)))
        .map((block) => block.text)
        .join(" ");
      if (!excerpts.has(visible)) excerpts.set(visible, raw);
    }
    const html = renderer.render(node);
    const rawHtml = node.type === "html_block" && html.trimEnd() === source.trimEnd();
    const blocks = visibleBlocks(html);
    for (let i = 0; i < blocks.length; i++) {
      while (
        INCOMPLETE_DECLARATION.test(blocks[i].text) &&
        i + 1 < blocks.length &&
        blocks[i].scope === blocks[i + 1].scope &&
        DECLARATION_START.test(blocks[i + 1].text)
      ) {
        const next = blocks.splice(i + 1, 1)[0];
        blocks[i].text += ` ${next.text}`;
        if (blocks[i].range && next.range)
          blocks[i].range = {
            start: Math.min(blocks[i].range.start, next.range.start),
            end: Math.max(blocks[i].range.end, next.range.end),
          };
      }
    }
    for (const block of blocks) {
      for (const text of sentences(block.text)) {
        const match = excerpts.get(text);
        const element =
          rawHtml && block.range?.element ? html.slice(block.range.start, block.range.end) : null;
        const focused =
          element &&
          visibleBlocks(element)
            .map((part) => part.text)
            .join(" ") === text;
        const original = focused
          ? element
          : match ||
            (rawHtml && block.textRange
              ? html.slice(block.textRange.start, block.textRange.end)
              : source);
        // DOM order may differ from source order. Source fallback is diagnostic
        // only: semantic refusal never depends on finding an original slice.
        statements.push({
          text,
          raw: (original || text).replace(/\s+/g, " ").trim(),
          context: focused || !match ? text : null,
        });
      }
    }
  }
  return statements;
}
