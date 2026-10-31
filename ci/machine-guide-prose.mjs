// Markdown owns inline/block context; parse5 owns HTML tokenizer states and
// entity consumption. Neither parser executes code or fetches destinations.
import { HtmlRenderer, Node, Parser } from "commonmark";
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
  "header",
  "main",
  "footer",
  "nav",
  "aside",
  "address",
  "details",
  "summary",
  "figure",
  "figcaption",
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
  "dl",
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

// Incomplete declarations may bridge layout/Markdown blocks, never independent
// list items or cells. A completed declaration cannot absorb the next block.
const PREDICATE_WORD = String.raw`are|is|be|has|have|contains?|includes?|returns?|holds?|shows?|occup(?:y|ies)`;
const LINK_WORD = String.raw`(?:${PREDICATE_WORD}|can|may|will|must)`;
const INCOMPLETE_DECLARATION = new RegExp(
  String.raw`^(?:(?:the|an?|each)\s+)?(?:event\s+)?(?:events?|collections?|rows?|items?|results?|responses?|payloads?|pages?|DTOs?|CallToolResult|JSON)(?:\s+${LINK_WORD})*$`,
  "i",
);
const DECLARATION_START = new RegExp(
  String.raw`^(?:${LINK_WORD}|caps?|limits?|limited|capped|bounds?|bounded|unlimited|unbounded|uncapped)\b`,
  "i",
);
const VALUE_PREFIX_END = new RegExp(String.raw`\b(?:${PREDICATE_WORD})$`, "i");

function sourceText(node, lines) {
  const [[firstLine, firstColumn], [lastLine, lastColumn]] = node.sourcepos;
  const sourceLines = lines.slice(firstLine - 1, lastLine);
  if (sourceLines.length === 1) sourceLines[0] = sourceLines[0].slice(firstColumn - 1, lastColumn);
  else {
    sourceLines[0] = sourceLines[0].slice(firstColumn - 1);
    sourceLines[sourceLines.length - 1] = sourceLines.at(-1).slice(0, lastColumn);
  }
  return sourceLines.join("\n").trim();
}

// Section identity follows Markdown structure, not heading-shaped source lines.
export function guideLimits(markdown) {
  const tree = new Parser().parse(markdown);
  const renderer = new HtmlRenderer();
  const headings = [];
  const walker = tree.walker();
  let event;
  while ((event = walker.next())) {
    if (!event.entering || event.node.type !== "heading" || event.node.level > 2) continue;
    const node = event.node;
    headings.push({
      node,
      title: visibleBlocks(renderer.render(node))
        .map((block) => block.text)
        .join(" "),
    });
  }
  const limits = headings.filter(({ node, title }) => node.level === 2 && title === "Limits");
  const first = limits[0];
  if (!first) return { count: 0, section: "", outside: markdown };
  const lines = markdown.split("\n");
  const start = first.node.sourcepos[0][0] - 1;
  const bodyStart = first.node.sourcepos[1][0];
  const next = headings
    .slice(headings.indexOf(first) + 1)
    .find((heading) => heading.node.parent === first.node.parent);
  const end = next ? next.node.sourcepos[0][0] - 1 : lines.length;
  return {
    count: limits.length,
    section: lines.slice(bodyStart, end).join("\n").replace(/\s+/g, " ").trim(),
    outside: [...lines.slice(0, start), ...lines.slice(end)].join("\n"),
  };
}

// CommonMark leaves GFM tables in paragraph nodes. Give recognized table
// cells real DOM boundaries before applying any subject/predicate association.
// Escaped pipes belong to a cell; code spans do not escape an unescaped pipe.
function tableCells(line) {
  const cells = [];
  let cell = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (line[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += line[i];
      if (line[i] === "\\" && i + 1 < line.length) cell += line[++i];
    }
  }
  cells.push(cell.trim());
  if (line.trimStart().startsWith("|")) cells.shift();
  if (line.trimEnd().endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells;
}

function markdownTree(markdown) {
  const parser = new Parser();
  const tree = parser.parse(markdown);
  const renderer = new HtmlRenderer();
  const renderInline = (text) => {
    // The pinned CommonMark inline pass retains the document's reference map
    // without treating a cell's leading '#' or '-' as block syntax.
    const document = new Node("document");
    const inline = new Node("paragraph");
    document.appendChild(inline);
    inline._string_content = text;
    parser.inlineParser.parse(inline);
    return renderer.render(inline);
  };
  const renderBlocks = (text) => {
    const fragmentParser = new Parser();
    const processInlines = fragmentParser.processInlines;
    fragmentParser.processInlines = function (block) {
      this.refmap = { ...parser.refmap, ...this.refmap };
      processInlines.call(this, block);
    };
    return renderer.render(fragmentParser.parse(text));
  };
  const lines = markdown.split("\n");
  const paragraphs = [];
  const walker = tree.walker();
  let event;
  while ((event = walker.next()))
    if (event.entering && event.node.type === "paragraph") paragraphs.push(event.node);
  for (const node of paragraphs) {
    const containers = [];
    for (let parent = node.parent; parent; parent = parent.parent)
      if (["block_quote", "item"].includes(parent.type)) containers.unshift(parent);
    const physical = sourceText(node, lines).split("\n");
    const records = physical.map((source, index) => {
      // Only indentation/container prefixes expand tabs. Inline cell source
      // remains unchanged. sourcepos already removed the first line's prefix.
      let line = source.replace(/^[ >\t]*/, (prefix) => {
        let column = 0;
        return Array.from(prefix, (char) => {
          const width = char === "\t" ? 4 - (column % 4) : 1;
          column += width;
          return char === "\t" ? " ".repeat(width) : char;
        }).join("");
      });
      let sameContainer = true;
      if (index > 0) {
        for (const container of containers) {
          const prefix =
            container.type === "block_quote"
              ? /^ {0,3}> ?/.exec(line)?.[0]
              : new RegExp(
                  `^ {${container._listData.markerOffset + container._listData.padding}}`,
                ).exec(line)?.[0];
          if (prefix === undefined) {
            sameContainer = false;
            break;
          }
          line = line.slice(prefix.length);
        }
      }
      return { text: line, sameContainer, code: /^ {4}/.test(line) };
    });
    const raw = records.map((record) => record.text);
    const tableLine = (index) => records[index].sameContainer && !records[index].code;
    const delimiter = raw.findIndex((line, index) => {
      if (
        index === 0 ||
        !tableLine(index) ||
        !tableLine(index - 1) ||
        !raw[index - 1].includes("|")
      )
        return false;
      const cells = tableCells(line);
      return (
        cells.length === tableCells(raw[index - 1]).length &&
        cells.every((cell) => /^:?-+:?$/.test(cell))
      );
    });
    if (delimiter < 0) continue;
    const header = tableCells(raw[delimiter - 1]);
    const renderRow = (cells, tag) =>
      `<tr>${header
        .map((_, index) => `<${tag}>${renderInline(cells[index] ?? "")}</${tag}>`)
        .join("")}</tr>`;
    const prefix = raw.slice(0, delimiter - 1).join("\n");
    let end = delimiter + 1;
    while (end < raw.length && tableLine(end)) end++;
    const suffix = raw.slice(end).join("\n");
    const table = new Node("html_block", node.sourcepos);
    table.literal = `${prefix ? renderInline(prefix) : ""}<table>${renderRow(header, "th")}${raw
      .slice(delimiter + 1, end)
      .map((row) => renderRow(tableCells(row), "td"))
      .join("")}</table>\n${suffix ? renderBlocks(suffix) : ""}`;
    node.insertBefore(table);
    node.unlink();
  }
  return tree;
}

function mergeRange(left, right) {
  return left && right
    ? { start: Math.min(left.start, right.start), end: Math.max(left.end, right.end) }
    : (left ?? right);
}

// Resolve diagnostic sources only for refused statements. Re-rendering excerpts
// is explanatory, never the authority for visibility or a passing verdict.
function describeSource(text, block, html, sources, markdown, cache) {
  const range = block.textRange ?? block.range;
  const related = range
    ? sources.filter((source) => source.start < range.end && source.end > range.start)
    : [];
  const key = related.length === 1 ? related[0] : related.map((item) => item.start).join(",");
  let cached = cache.sources.get(key);
  if (!cached) {
    const source = related.length ? related.map((item) => item.raw).join("\n") : markdown;
    const renderer = new HtmlRenderer();
    const excerpts = new Map();
    for (const raw of sentences(source, /(?<=[.!?])(?:\s+|&(?:nbsp|#32|#x20);?)+/gi)) {
      const visible = visibleBlocks(renderer.render(new Parser().parse(raw)))
        .map((part) => part.text)
        .join(" ");
      if (!excerpts.has(visible)) excerpts.set(visible, raw);
    }
    cached = { source, excerpts };
    cache.sources.set(key, cached);
  }
  const { source, excerpts } = cached;
  const match = excerpts.get(text);
  const rawHtml = related.length > 0 && related.every((item) => item.rawHtml);
  const element =
    rawHtml && block.range?.element ? html.slice(block.range.start, block.range.end) : null;
  let focused = false;
  if (element) {
    const key = `${block.range.start}:${block.range.end}`;
    let visible = cache.elements.get(key);
    if (visible === undefined) {
      visible = visibleBlocks(element)
        .map((part) => part.text)
        .join(" ");
      cache.elements.set(key, visible);
    }
    focused = visible === text;
  }
  const original = focused
    ? element
    : match ||
      (rawHtml && block.textRange
        ? html.slice(block.textRange.start, block.textRange.end)
        : source);
  return {
    raw: (original || text).replace(/\s+/g, " ").trim(),
    context: focused || !match ? text : null,
  };
}

export function guideStatements(
  markdown,
  completesValue = () => false,
  continuesScope = () => false,
  awaitsValue = () => false,
  continuesCount = () => false,
) {
  const tree = markdownTree(markdown);
  const renderer = new HtmlRenderer();
  // One complete DOM preserves template/RAWTEXT ancestors and continuity
  // across CommonMark nodes. Individual fragments cannot establish visibility.
  const html = renderer.render(tree);
  const lines = markdown.split("\n");
  const sources = [];
  const walker = tree.walker();
  let cursor = 0;
  let event;
  while ((event = walker.next())) {
    const node = event.node;
    if (
      !event.entering ||
      !["paragraph", "heading", "code_block", "html_block"].includes(node.type)
    )
      continue;
    const fragment = renderer.render(node);
    const start = html.indexOf(fragment, cursor);
    if (start < 0) continue; // Missing source mapping never suppresses a claim.
    const raw = sourceText(node, lines);
    sources.push({
      start,
      end: start + fragment.length,
      raw,
      rawHtml: node.type === "html_block" && fragment.trimEnd() === raw.trimEnd(),
    });
    cursor = start + fragment.length;
  }
  const blocks = visibleBlocks(html);
  for (let i = 0; i < blocks.length; i++) {
    while (
      (INCOMPLETE_DECLARATION.test(blocks[i].text) || awaitsValue(blocks[i].text)) &&
      i + 1 < blocks.length &&
      blocks[i].scope === blocks[i + 1].scope
    ) {
      let count = 1;
      if (!DECLARATION_START.test(blocks[i + 1].text)) {
        if (!VALUE_PREFIX_END.test(blocks[i].text) && !awaitsValue(blocks[i].text)) break;
        let candidate = blocks[i].text;
        let end = i;
        for (let j = i + 1; j < blocks.length && blocks[j].scope === blocks[i].scope; j++) {
          candidate += ` ${blocks[j].text}`;
          if (completesValue(candidate)) {
            end = j;
            break;
          }
          if (INCOMPLETE_DECLARATION.test(blocks[j].text) || /[.;!?]$/.test(blocks[j].text)) break;
        }
        if (end === i) break;
        count = end - i;
      }
      for (let part = 0; part < count; part++) {
        const next = blocks.splice(i + 1, 1)[0];
        blocks[i].text += ` ${next.text}`;
        blocks[i].range = mergeRange(blocks[i].range, next.range);
        blocks[i].textRange = mergeRange(blocks[i].textRange, next.textRange);
      }
    }
    // A count may finish before its aggregate qualifier in the next layout
    // block. Bind only a scope accepted by the same declaration grammar.
    if (
      i + 1 < blocks.length &&
      blocks[i].scope === blocks[i + 1].scope &&
      /^(?:across|in|per)\b/i.test(blocks[i + 1].text)
    ) {
      let scope = "";
      let end = i;
      for (let j = i + 1; j < blocks.length && blocks[j].scope === blocks[i].scope; j++) {
        scope += `${scope ? " " : ""}${blocks[j].text}`;
        if (continuesScope(blocks[i].text, scope)) {
          // Punctuation or a per-response suffix may continue this clause;
          // do not commit to a standalone qualifier before consuming it.
          const next = blocks[j + 1];
          const continued =
            !/[.!?]$/.test(scope) &&
            next?.scope === blocks[i].scope &&
            /^(?:,|per(?:[\s-]+(?:page|response)\b|$))/i.test(next.text);
          if (!continued) {
            end = j;
            break;
          }
        }
        if (INCOMPLETE_DECLARATION.test(blocks[j].text) || /[.;!?]$/.test(blocks[j].text)) break;
      }
      for (let part = i; part < end; part++) {
        const next = blocks.splice(i + 1, 1)[0];
        blocks[i].text += ` ${next.text}`;
        blocks[i].range = mergeRange(blocks[i].range, next.range);
        blocks[i].textRange = mergeRange(blocks[i].textRange, next.textRange);
      }
    }
    while (
      i + 1 < blocks.length &&
      blocks[i].scope === blocks[i + 1].scope &&
      continuesCount(blocks[i].text, blocks[i + 1].text)
    ) {
      const next = blocks.splice(i + 1, 1)[0];
      blocks[i].text += ` ${next.text}`;
      blocks[i].range = mergeRange(blocks[i].range, next.range);
      blocks[i].textRange = mergeRange(blocks[i].textRange, next.textRange);
    }
  }
  const statements = [];
  // Failure floods share source blocks; compute each explanatory projection
  // once, without caching visibility decisions across documents.
  const cache = { sources: new Map(), elements: new Map() };
  for (const block of blocks) {
    for (const text of sentences(block.text)) {
      let description;
      const describe = () =>
        (description ??= describeSource(text, block, html, sources, markdown, cache));
      statements.push({
        text,
        get raw() {
          return describe().raw;
        },
        get context() {
          return describe().context;
        },
      });
    }
  }
  return statements;
}
