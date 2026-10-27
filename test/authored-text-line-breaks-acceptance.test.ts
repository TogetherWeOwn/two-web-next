// Acceptance-owned: authored line breaks must be *rendered* on schedule
// cards (excerpt, full disclosure text and marked search passages), featured
// bodies and archive passages, in Hono and Kit output — as they already are
// on event detail pages (the CONTROL below).
//
// Breaks caught: authored "\n" reaching the page as collapsible whitespace
// (the text is present but displays as one run-on line); breaks lost inside
// <mark> segmentation; markup or autolinks introduced while "fixing" breaks;
// long unbroken words overflowing instead of wrapping.
//
// The oracle is mechanism-agnostic and works from the rendered artifacts:
// it renders the real pages, collects the stylesheets those pages actually
// serve (linked sheets in document order, inline <style>, the Kit global
// sheet and captured component CSS), and computes each authored-text
// container's rendered lines the way a browser would — literal newlines
// count only when the effective CSS preserves them (white-space:
// pre/pre-wrap/pre-line/break-spaces, white-space-collapse: preserve*,
// an inline style, or an equivalent utility class); <br> and block
// boundaries always count. A fix in markup or in CSS can satisfy it; the
// current output, where newlines collapse, cannot.
//
// Hermetic: local component/route fixtures only, no database, no network.
// Run: npx vitest run test/authored-text-line-breaks-acceptance.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { EventPage, EventsCalendarPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import type { VisibleFeatured } from "../src/featured";
import { FALLBACK_RANKS, HOME_JOIN_RESULT_COPY, HOME_NOTICES } from "../src/home-copy";
import { renderEventsHtml } from "../src/kit-events-html";
import { Home } from "../src/pages";
import { EVENT_KEY, scanEvent } from "./calendar-card-scan.fixtures";
import {
  ARCHIVE_NOW,
  archiveReadFixture,
  archiveRow,
  archiveTwins,
  compileArchiveKit,
  requestArchive,
} from "./helpers/past-archive-search-acceptance";
import {
  attribute,
  document,
  elements,
  tag,
  text,
  type Element,
} from "./helpers/schedule-search-context-acceptance";

vi.mock("../src/events/search-log", async (original) => ({
  ...(await original<typeof import("../src/events/search-log")>()),
  recordSearch: vi.fn(async () => {}),
}));

type DomNode = Parameters<typeof text>[0];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Fixtures: hand-written authored text and hand-derived expected lines.
// ---------------------------------------------------------------------------
const MULTI = "Doors at seven\nBring a deck\n\nNew players welcome";
const MULTI_LINES = ["Doors at seven", "Bring a deck", "", "New players welcome"];
const SINGLE = "Doors at seven, bring a deck";
const TRAILING = "Doors at seven\nBring a deck\n";
const TRAILING_LINES = ["Doors at seven", "Bring a deck"];
const LONG_TOKEN = "q".repeat(90);
const LONG_WORD = `Token ${LONG_TOKEN} end`;
const HOSTILE =
  "<script>alert(1)</script> <b>bold</b> https://evil.example/x www.evil.example a@evil.example";
const LONG_MULTI =
  "First line here\nSecond line here\n\n" +
  "Filler sentence for the card. ".repeat(12) +
  "\nFinal tail line";
const LONG_MULTI_LINES = [
  "First line here",
  "Second line here",
  "",
  "Filler sentence for the card. ".repeat(12).trim(),
  "Final tail line",
];
const SEARCH_SHORT = "Bring snacks\nNeedle hunt after\n\nAll welcome";
const SEARCH_SHORT_LINES = ["Bring snacks", "Needle hunt after", "", "All welcome"];
const SEARCH_LONG =
  "Needle opens the night\nBring snacks and decks. " + "More filler words here. ".repeat(12);
const ARCHIVE_MULTI = "Archive doors\nNeedle archive clue\n\nArchive finale";
const ARCHIVE_MULTI_LINES = ["Archive doors", "Needle archive clue", "", "Archive finale"];

// ---------------------------------------------------------------------------
// CSS oracle: parse served stylesheets, match selectors against the real
// rendered element chain, and resolve the effective (inherited) declaration.
// Only enough of CSS to judge whitespace/wrapping on these pages; unknown
// pseudo-classes simply do not match.
// ---------------------------------------------------------------------------
type Decl = { value: string; important: boolean };
type CssRule = {
  selectors: string[];
  declarations: Map<string, Decl>;
  order: number;
  source: string;
};

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === separator && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function parseDeclarations(body: string): Map<string, Decl> {
  const declarations = new Map<string, Decl>();
  for (const chunk of splitTopLevel(body, ";")) {
    const colon = chunk.indexOf(":");
    if (colon === -1) continue;
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    let value = chunk.slice(colon + 1).trim();
    const important = /!important\s*$/i.test(value);
    if (important) value = value.replace(/!important\s*$/i, "").trim();
    if (prop) declarations.set(prop, { value: value.toLowerCase(), important });
  }
  return declarations;
}

function readBlock(css: string, open: number): { content: string; end: number } {
  let depth = 0;
  let quote = "";
  for (let i = open; i < css.length; i++) {
    const ch = css[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return { content: css.slice(open + 1, i), end: i };
  }
  return { content: css.slice(open + 1), end: css.length };
}

// Explicit desktop context: screen, 1280 × 800 CSS pixels. This bounded oracle
// understands media types, px width/height bounds, orientation, comma alternatives
// and whole-query negation. Supports queries cover the judged text properties.
// Unknown conditions affecting those properties fail loudly, never count as active.
// Layer blocks group rules, but this oracle does not model cross-layer precedence.
const CSS_VIEWPORT = { width: 1280, height: 800 };
const CSS_SUPPORT = new Map([
  ["white-space", new Set(["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"])],
  ["white-space-collapse", new Set(["collapse", "preserve", "preserve-breaks", "preserve-spaces"])],
  ["overflow-wrap", new Set(["normal", "anywhere", "break-word"])],
  ["word-break", new Set(["normal", "break-all", "keep-all", "break-word"])],
]);

function activeCssGroup(prelude: string, source: string): boolean {
  const unsupported = (): never => {
    throw new Error(
      `CSS oracle cannot evaluate ${prelude} (${source}); extend its explicit context`,
    );
  };
  if (/^@layer\b/.test(prelude)) return true;
  if (/^@media\b/.test(prelude)) {
    const alternatives = splitTopLevel(prelude.slice(6).trim().toLowerCase(), ",").map((query) => {
      const negate = /^not\s+/.test(query.trim());
      const terms = query
        .trim()
        .replace(/^(not|only)\s+/, "")
        .split(/\s+and\s+/);
      const matches = terms.map((term, index) => {
        if (index === 0 && /^(all|screen|print)$/.test(term)) return term !== "print";
        const bound = /^\(\s*(?:(min|max)-)?(width|height)\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(
          term,
        );
        if (bound) {
          const size = CSS_VIEWPORT[bound[2] as "width" | "height"];
          const limit = Number(bound[3]);
          return bound[1] === "min"
            ? size >= limit
            : bound[1] === "max"
              ? size <= limit
              : size === limit;
        }
        const orientation = /^\(\s*orientation\s*:\s*(landscape|portrait)\s*\)$/.exec(term);
        if (orientation) return orientation[1] === "landscape";
        return unsupported();
      });
      const active = matches.every(Boolean);
      return negate ? !active : active;
    });
    return alternatives.some(Boolean);
  }
  if (/^@supports\b/.test(prelude)) {
    const condition = prelude.slice(9).trim().toLowerCase();
    const negate = /^not\s+/.test(condition);
    const declaration = /^\(\s*([\w-]+)\s*:\s*([\w-]+)\s*\)$/.exec(
      condition.replace(/^not\s+/, ""),
    );
    if (!declaration) return unsupported();
    const values = CSS_SUPPORT.get(declaration[1]!);
    if (!values) return unsupported();
    const active = values.has(declaration[2]!);
    return negate ? !active : active;
  }
  // Container dimensions and document conditions are not available from the
  // parsed fixture DOM. Refuse to infer them from a selector or the viewport.
  return unsupported();
}

function parseCss(css: string, source: string, state: { order: number }, out: CssRule[]): void {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < clean.length) {
    let brace = -1;
    let semi = -1;
    let quote = "";
    let depth = 0;
    for (let j = i; j < clean.length; j++) {
      const ch = clean[j]!;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && ch === "{") {
        brace = j;
        break;
      } else if (depth === 0 && ch === ";") {
        semi = j;
        break;
      }
    }
    if (semi !== -1) {
      i = semi + 1; // @import and friends: no declarations for elements
      continue;
    }
    if (brace === -1) break;
    const prelude = clean.slice(i, brace).trim();
    const block = readBlock(clean, brace);
    if (/^@(media|supports|layer|container|document)\b/.test(prelude)) {
      const affectsText = /\b(?:white-space(?:-collapse)?|overflow-wrap|word-break)\s*:/i.test(
        block.content,
      );
      if (affectsText && activeCssGroup(prelude, source)) {
        parseCss(block.content, source, state, out);
      }
    } else if (prelude && !prelude.startsWith("@")) {
      out.push({
        selectors: splitTopLevel(prelude, ",")
          .map((s) => s.trim())
          .filter(Boolean),
        declarations: parseDeclarations(block.content),
        order: state.order++,
        source,
      });
    }
    i = block.end + 1;
  }
}

/** Stylesheets a rendered page serves, in document order, plus test-supplied
 * extras (the Kit global sheet / captured component CSS). */
function servedRules(html: string, extras: { css: string; source: string }[] = []): CssRule[] {
  const rules: CssRule[] = [];
  const state = { order: 0 };
  const chunks: { css: string; source: string }[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>|<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    if (match[1] !== undefined) {
      chunks.push({ css: match[1], source: "inline <style>" });
      continue;
    }
    const tagText = match[0];
    if (!/\brel\s*=\s*"stylesheet"/.test(tagText)) continue;
    const href = /\bhref\s*=\s*"([^"]+)"/.exec(tagText)?.[1];
    if (!href || !href.startsWith("/")) continue;
    const path = href.split("?")[0]!;
    chunks.push({ css: readFileSync(join(root, "public", path), "utf8"), source: path });
  }
  for (const chunk of [...chunks, ...extras]) parseCss(chunk.css, chunk.source, state, rules);
  return rules;
}

function classList(el: Element): string[] {
  return (attribute(el, "class") ?? "").split(/\s+/).filter(Boolean);
}

function ancestorsOf(el: Element): Element[] {
  const chain: Element[] = [];
  let node = (el as { parentNode?: DomNode }).parentNode;
  while (node) {
    if ("tagName" in node) chain.push(node as Element);
    node = (node as { parentNode?: DomNode }).parentNode;
  }
  return chain;
}

function matchAttr(el: Element, inner: string): boolean {
  const m =
    /^\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"'\]]+)))?\s*[iIsS]?\s*$/.exec(
      inner,
    );
  if (!m) return false;
  const actual = attribute(el, m[1]!);
  if (actual === undefined) return false;
  if (!m[2]) return true;
  const want = m[3] ?? m[4] ?? m[5] ?? "";
  return m[2] === "~=" ? actual.split(/\s+/).includes(want) : actual === want;
}

function matchCompound(el: Element, compoundRaw: string): boolean {
  let compound = compoundRaw.trim();
  if (!compound) return false;
  for (const fn of [":is(", ":where(", ":global(", ":not("] as const) {
    const at = compound.indexOf(fn);
    if (at === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = at + fn.length - 1; i < compound.length; i++) {
      if (compound[i] === "(") depth++;
      else if (compound[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) return false;
    const inner = compound.slice(at + fn.length, end);
    const before = compound.slice(0, at);
    const after = compound.slice(end + 1);
    const alts = splitTopLevel(inner, ",").map((alt) => alt.trim());
    return fn === ":not("
      ? matchCompound(el, `${before}${after}` || "*") &&
          alts.every((alt) => !matchCompound(el, alt))
      : alts.some((alt) => matchCompound(el, `${before}${alt}${after}` || "*"));
  }
  if (compound.includes("::")) return false;
  if (compound === ":root") return el.tagName === "html";
  if (compound.includes(":")) return false;
  const tagMatch = /^(\*|[a-zA-Z][\w-]*)/.exec(compound);
  if (tagMatch) {
    if (tagMatch[1] !== "*" && el.tagName !== tagMatch[1]!.toLowerCase()) return false;
    compound = compound.slice(tagMatch[1]!.length);
  }
  const token = /([.#])([\w-]+)|\[([^\]]+)\]/g;
  let consumed = 0;
  for (let m = token.exec(compound); m; m = token.exec(compound)) {
    consumed = token.lastIndex;
    if (m[1] === "." && !classList(el).includes(m[2]!)) return false;
    if (m[1] === "#" && attribute(el, "id") !== m[2]) return false;
    if (m[3] !== undefined && !matchAttr(el, m[3])) return false;
  }
  return consumed === compound.length;
}

function splitComplex(selector: string): { compounds: string[]; combinators: string[] } {
  const compounds: string[] = [];
  const combinators: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  let i = 0;
  const flush = (end: number) => {
    const piece = selector.slice(start, end).trim();
    if (piece) compounds.push(piece);
  };
  while (i < selector.length) {
    const ch = selector[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (ch === ">" || ch === "+" || ch === "~" || /\s/.test(ch))) {
      flush(i);
      let combinator = " ";
      while (i < selector.length && /\s/.test(selector[i]!)) i++;
      if (i < selector.length && [">", "+", "~"].includes(selector[i]!)) {
        combinator = selector[i]!;
        i++;
        while (i < selector.length && /\s/.test(selector[i]!)) i++;
      }
      if (i < selector.length) combinators.push(combinator);
      start = i;
      continue;
    }
    i++;
  }
  flush(selector.length);
  return { compounds, combinators };
}

function matchComplex(el: Element, ancestors: Element[], selector: string): boolean {
  const { compounds, combinators } = splitComplex(selector);
  if (compounds.length === 0 || !matchCompound(el, compounds[compounds.length - 1]!)) return false;
  let ai = 0;
  for (let ci = compounds.length - 2; ci >= 0; ci--) {
    if (combinators[ci] === ">") {
      if (ai >= ancestors.length || !matchCompound(ancestors[ai]!, compounds[ci]!)) return false;
      ai++;
    } else {
      let found = -1;
      for (let j = ai; j < ancestors.length; j++) {
        if (matchCompound(ancestors[j]!, compounds[ci]!)) {
          found = j;
          break;
        }
      }
      if (found === -1) return false;
      ai = found + 1;
    }
  }
  return true;
}

function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const tags = (selector.match(/(^|[\s>+~,(])([a-zA-Z][\w-]*)/g) ?? []).length;
  return ids * 100 + classes * 10 + tags;
}

type Effective = { value: string; via: string } | null;

function effectiveDecl(el: Element, rules: CssRule[], prop: string): Effective {
  const chain = [el, ...ancestorsOf(el)];
  for (let idx = 0; idx < chain.length; idx++) {
    const node = chain[idx]!;
    const style = attribute(node, "style");
    if (style) {
      const inline = parseDeclarations(style).get(prop);
      if (inline) return { value: inline.value, via: `inline style on <${node.tagName}>` };
    }
    const candidates: { decl: Decl; spec: number; order: number; sel: string; source: string }[] =
      [];
    for (const rule of rules) {
      const decl = rule.declarations.get(prop);
      if (!decl) continue;
      for (const sel of rule.selectors) {
        if (matchComplex(node, chain.slice(idx + 1), sel)) {
          candidates.push({
            decl,
            spec: specificity(sel),
            order: rule.order,
            sel,
            source: rule.source,
          });
        }
      }
    }
    if (candidates.length > 0) {
      candidates.sort(
        (a, b) =>
          Number(b.decl.important) - Number(a.decl.important) ||
          b.spec - a.spec ||
          b.order - a.order,
      );
      const best = candidates[0]!;
      return { value: best.decl.value, via: `${best.sel} (${best.source})` };
    }
  }
  return null;
}

const PRESERVING_WS = new Set(["pre", "pre-wrap", "pre-line", "break-spaces"]);
const WS_UTILITIES = new Set([
  "whitespace-pre",
  "whitespace-pre-wrap",
  "whitespace-pre-line",
  "whitespace-break-spaces",
]);
const WRAP_UTILITIES = new Set(["wrap-anywhere", "wrap-break-word", "break-all"]);

function chainClasses(el: Element): string[] {
  return [el, ...ancestorsOf(el)].flatMap(classList);
}

function preservesBreaks(el: Element, rules: CssRule[]): { preserved: boolean; detail: string } {
  const utility = chainClasses(el).find((c) => WS_UTILITIES.has(c));
  if (utility) return { preserved: true, detail: `utility class .${utility}` };
  const ws = effectiveDecl(el, rules, "white-space");
  if (ws && PRESERVING_WS.has(ws.value))
    return { preserved: true, detail: `white-space: ${ws.value} via ${ws.via}` };
  const collapse = effectiveDecl(el, rules, "white-space-collapse");
  if (collapse && (collapse.value === "preserve" || collapse.value === "preserve-breaks"))
    return {
      preserved: true,
      detail: `white-space-collapse: ${collapse.value} via ${collapse.via}`,
    };
  return {
    preserved: false,
    detail: ws ? `white-space: ${ws.value} via ${ws.via}` : "no white-space rule applies",
  };
}

function wrapsLongWords(el: Element, rules: CssRule[]): { wraps: boolean; detail: string } {
  const utility = chainClasses(el).find((c) => WRAP_UTILITIES.has(c));
  if (utility) return { wraps: true, detail: `utility class .${utility}` };
  const wrap = effectiveDecl(el, rules, "overflow-wrap");
  if (wrap && (wrap.value === "anywhere" || wrap.value === "break-word"))
    return { wraps: true, detail: `overflow-wrap: ${wrap.value} via ${wrap.via}` };
  const wordBreak = effectiveDecl(el, rules, "word-break");
  if (wordBreak && (wordBreak.value === "break-all" || wordBreak.value === "break-word"))
    return { wraps: true, detail: `word-break: ${wordBreak.value} via ${wordBreak.via}` };
  return {
    wraps: false,
    detail: wrap ? `overflow-wrap: ${wrap.value} via ${wrap.via}` : "no overflow-wrap rule applies",
  };
}

// ---------------------------------------------------------------------------
// Rendered-lines extraction: what a reader sees, line by line.
// ---------------------------------------------------------------------------
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "details",
  "div",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "main",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
  "ol",
]);
const SKIP_TAGS = new Set(["script", "style", "template", "noscript"]);

function renderedLines(container: Element, rules: CssRule[], skipHeadings = false): string[] {
  const preserve = preservesBreaks(container, rules).preserved;
  let out = "";
  const walk = (node: DomNode): void => {
    if (node.nodeName === "#text") {
      const value = (node as { value: string }).value;
      out += preserve ? value : value.replace(/\s+/g, " ");
      return;
    }
    if (!("tagName" in node)) {
      if ("childNodes" in node) for (const child of node.childNodes) walk(child as DomNode);
      return;
    }
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (skipHeadings && /^h[1-6]$/.test(el.tagName)) return;
    if (el.tagName === "br") {
      out += "\n";
      return;
    }
    const block = BLOCK_TAGS.has(el.tagName);
    if (block) out += "\n\n";
    for (const child of el.childNodes) walk(child as DomNode);
    if (block) out += "\n\n";
  };
  for (const child of container.childNodes) walk(child as DomNode);
  const lines: string[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "" && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function expectLines(
  container: Element,
  expected: string[],
  rules: CssRule[],
  label: string,
  skipHeadings = false,
): void {
  const actual = renderedLines(container, rules, skipHeadings);
  expect(
    actual,
    `${label}: authored breaks must render as lines; ${preservesBreaks(container, rules).detail}; ` +
      `container <${container.tagName} class="${attribute(container, "class") ?? ""}"> ` +
      `raw text ${JSON.stringify(text(container)).slice(0, 240)}`,
  ).toEqual(expected);
}

function expectLinePrefix(
  container: Element,
  prefix: string[],
  rules: CssRule[],
  label: string,
): string[] {
  const actual = renderedLines(container, rules);
  expect(
    actual.slice(0, prefix.length),
    `${label}: opening authored lines must render; ${preservesBreaks(container, rules).detail}`,
  ).toEqual(prefix);
  return actual;
}

/** Smallest (by inclusion, then text size) element under root whose text
 * contains every needle — the authored-text container, whatever markup the
 * implementation chooses for it. */
function smallestContaining(rootEl: DomNode, needles: string[], label: string): Element {
  const candidates = elements(
    rootEl,
    (el) => !SKIP_TAGS.has(el.tagName) && needles.every((n) => text(el).includes(n)),
  );
  expect(candidates.length, `${label}: authored text reaches the page`).toBeGreaterThan(0);
  const minimal = candidates.filter(
    (c) => !candidates.some((other) => other !== c && ancestorsOf(other).includes(c)),
  );
  minimal.sort((a, b) => text(a).length - text(b).length);
  return minimal[0]!;
}

function expectPlainText(container: Element, label: string): void {
  const created = elements(container, (el) =>
    ["a", "script", "b", "strong", "em", "i", "img", "svg", "iframe", "button"].includes(
      el.tagName,
    ),
  );
  expect(
    created.map((el) => el.tagName),
    `${label}: authored text is never markup or autolinked`,
  ).toEqual([]);
  expect(text(container), `${label}: hostile text stays literal`).toContain(
    "<script>alert(1)</script>",
  );
  expect(text(container)).toContain("https://evil.example/x");
}

function expectWrappable(container: Element, rules: CssRule[], label: string): void {
  const verdict = wrapsLongWords(container, rules);
  expect(verdict.wraps, `${label}: long unbroken word must wrap; ${verdict.detail}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Oracle controls: a declaration must actually apply before it can preserve
// authored lines. These exercise the same served-rule → rendered-line path as
// the page cases, with literal expectations independent of the matcher.
// ---------------------------------------------------------------------------
describe("CSS oracle applicability controls", () => {
  const markup = `<main class="content-theme"><article data-testid="featured-item"><p>${MULTI}</p></article></main>`;
  const selector = "[data-testid='featured-item'] p";

  function linesWith(css: string): string[] {
    const html = `<style>${css}</style>${markup}`;
    const container = smallestContaining(document(html), MULTI_LINES.filter(Boolean), "control");
    return renderedLines(container, servedRules(html));
  }

  it.each([
    ["missing ancestor before :not", `.unrelated:not(.content-theme) ${selector}`],
    ["missing suffix after :not", `.content-theme:not(.unrelated).missing ${selector}`],
    ["excluded ancestor", `.content-theme:not(.content-theme) ${selector}`],
    ["one excluded alternative", `.content-theme:not(.missing, .content-theme) ${selector}`],
  ])("rejects a whitespace declaration with %s", (_label, nonmatching) => {
    expect(linesWith(`${nonmatching} { white-space: pre-line; }`)).toEqual([
      "Doors at seven Bring a deck New players welcome",
    ]);
  });

  it.each([
    `.content-theme:not(.unrelated) ${selector}`,
    `:not(.unrelated).content-theme ${selector}`,
    `.content-theme:not(.unrelated, .missing) ${selector}`,
    `.content-theme:not(.unrelated):not(.missing) ${selector}`,
  ])("admits a matching negation: %s", (matching) => {
    expect(linesWith(`${matching} { white-space: pre-line; }`)).toEqual(MULTI_LINES);
  });

  it.each([
    "@media (max-width: 1px)",
    "@media (min-width: 1281px)",
    "@media print",
    "@media screen and (max-height: 799px)",
    "@media not screen",
    "@supports (white-space: unsupported-oracle-value)",
    "@supports not (white-space: pre-line)",
  ])("rejects an inactive conditional: %s", (conditional) => {
    expect(linesWith(`${conditional} { ${selector} { white-space: pre-line; } }`)).toEqual([
      "Doors at seven Bring a deck New players welcome",
    ]);
  });

  it.each([
    "@media screen and (min-width: 1280px) and (max-height: 800px)",
    "@media print, (min-width: 1280px)",
    "@media (orientation: landscape)",
    "@media not print",
    "@supports (white-space: pre-line)",
    "@supports not (white-space: unsupported-oracle-value)",
    "@layer content",
  ])("admits an active grouping rule: %s", (conditional) => {
    expect(linesWith(`${conditional} { ${selector} { white-space: pre-line; } }`)).toEqual(
      MULTI_LINES,
    );
  });

  it("does not reactivate an inactive rule nested in an active group", () => {
    expect(
      linesWith(
        `@media screen { @supports (white-space: pre-line) { @media (max-width: 1px) { ${selector} { white-space: pre-line; } } } }`,
      ),
    ).toEqual(["Doors at seven Bring a deck New players welcome"]);
  });

  it.each([
    "@media (width > 100px)",
    "@supports selector(:has(p))",
    "@container (min-width: 1px)",
    "@document url-prefix(https://example.test)",
  ])("fails closed rather than guessing an unmodeled condition: %s", (conditional) => {
    expect(() => linesWith(`${conditional} { ${selector} { white-space: pre-line; } }`)).toThrow(
      "CSS oracle cannot evaluate",
    );
  });
});

// ---------------------------------------------------------------------------
// Calendar cards: Hono screen and the Kit events endpoint render of it.
// ---------------------------------------------------------------------------
async function renderCalendarTwin(
  twin: "Hono" | "Kit",
  description: string | null,
  q = "",
): Promise<string> {
  const data = {
    state: { view: "list" as const, month: "2027-02", q, game: "", past: false, page: 1 },
    upcoming: [scanEvent({ description })],
    past: [],
    zone: "UTC",
    now: new Date("2027-01-15T12:00:00Z"),
    totalPages: 1,
    emptyState: null,
    robots: undefined,
    discordFailed: false,
    games: [],
    gameFilter: null,
    member: false,
    session: null,
    moderator: false,
    inviteUrl: "https://discord.gg/fixture",
    appUrl: "https://calendar.example.test",
    canonical: "https://calendar.example.test/events",
    loginReturnTo: "/events",
    joinResult: null,
    queryTooLong: false,
  };
  return twin === "Hono"
    ? await jsx(EventsCalendarPage, data).toString()
    : (await renderEventsHtml(data, {})).body;
}

function calendarCard(html: string): { card: Element; rules: CssRule[] } {
  const doc = document(html);
  const cards = elements(
    doc,
    (el) => el.tagName === "article" && attribute(el, "data-event-key") === EVENT_KEY,
  );
  expect(cards, "fixture event reaches the real list card").toHaveLength(1);
  return { card: cards[0]!, rules: servedRules(html) };
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} schedule card authored line breaks`, () => {
    it("renders multi-paragraph short text as authored lines", async () => {
      const { card, rules } = calendarCard(await renderCalendarTwin(twin, MULTI));
      expectLines(
        smallestContaining(card, MULTI_LINES.filter(Boolean), "short card"),
        MULTI_LINES,
        rules,
        `${twin} short card`,
      );
    });

    it("leaves single-line text on one line", async () => {
      const { card, rules } = calendarCard(await renderCalendarTwin(twin, SINGLE));
      expectLines(
        smallestContaining(card, [SINGLE], "single-line card"),
        [SINGLE],
        rules,
        `${twin} single-line card`,
      );
    });

    it("renders a trailing newline without inventing extra content", async () => {
      const { card, rules } = calendarCard(await renderCalendarTwin(twin, TRAILING));
      expectLines(
        smallestContaining(card, TRAILING_LINES, "trailing card"),
        TRAILING_LINES,
        rules,
        `${twin} trailing-newline card`,
      );
    });

    it("keeps a long unbroken word intact and wrappable", async () => {
      const { card, rules } = calendarCard(await renderCalendarTwin(twin, LONG_WORD));
      const container = smallestContaining(card, [LONG_TOKEN], "long-word card");
      expectLines(container, [LONG_WORD], rules, `${twin} long-word card`);
      expectWrappable(container, rules, `${twin} long-word card`);
    });

    it("renders authored breaks in the long excerpt and the full disclosure text", async () => {
      const { card, rules } = calendarCard(await renderCalendarTwin(twin, LONG_MULTI));
      const excerpt =
        elements(card, (el) => classList(el).includes("schedule-excerpt"))[0] ??
        smallestContaining(tag(card, "summary")[0]!, ["First line here"], "excerpt");
      const excerptLines = expectLinePrefix(
        excerpt,
        ["First line here", "Second line here", ""],
        rules,
        `${twin} excerpt`,
      );
      expect(excerptLines[3], `${twin} excerpt continues into the filler`).toMatch(
        /^Filler sentence for the card\./,
      );
      const full = smallestContaining(card, ["First line here", "Final tail line"], "full text");
      expectLines(full, LONG_MULTI_LINES, rules, `${twin} full disclosure text`);
    });

    it("renders authored breaks in a short search passage and keeps its marks", async () => {
      const { card, rules } = calendarCard(await renderCalendarTwin(twin, SEARCH_SHORT, "needle"));
      const passage = smallestContaining(card, ["All welcome"], "short search passage");
      expectLines(passage, SEARCH_SHORT_LINES, rules, `${twin} short search passage`);
      expect(tag(passage, "mark").map(text)).toEqual(["Needle"]);
    });

    it("renders authored breaks in the long search excerpt and full text, with marks", async () => {
      const { card, rules } = calendarCard(await renderCalendarTwin(twin, SEARCH_LONG, "needle"));
      const excerpt =
        elements(card, (el) => classList(el).includes("schedule-excerpt"))[0] ??
        smallestContaining(tag(card, "summary")[0]!, ["Needle opens the night"], "search excerpt");
      const excerptLines = expectLinePrefix(
        excerpt,
        ["Needle opens the night"],
        rules,
        `${twin} search excerpt`,
      );
      expect(excerptLines[1], `${twin} search excerpt second line`).toMatch(
        /^Bring snacks and decks\./,
      );
      expect(tag(excerpt, "mark").map(text)).toEqual(["Needle"]);
      const full = smallestContaining(
        card,
        ["Needle opens the night", "Bring snacks and decks."],
        "search full text",
      );
      const fullLines = expectLinePrefix(
        full,
        ["Needle opens the night"],
        rules,
        `${twin} search full text`,
      );
      expect(fullLines[1]).toMatch(/^Bring snacks and decks\./);
    });

    it("never interprets authored text as markup and never autolinks it", async () => {
      const { card } = calendarCard(await renderCalendarTwin(twin, HOSTILE));
      const container = smallestContaining(card, ["https://evil.example/x"], "hostile card");
      expectPlainText(container, `${twin} hostile card`);
    });
  });
}

// ---------------------------------------------------------------------------
// Featured bodies: Hono home screen and compiled Kit home SSR.
// ---------------------------------------------------------------------------
function renderFeaturedHono(body: string): string {
  const featured: VisibleFeatured[] = [
    {
      id: 1,
      title: "Fixture feature",
      body,
      url: null,
      imageUrl: null,
      imageAlt: null,
    },
  ];
  return Home({
    session: null,
    notice: null,
    inviteUrl: "https://discord.gg/invite",
    appUrl: "https://next.example.test",
    counts: { memberCount: null, onlineCount: null, ranks: [] },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured,
  })!.toString() as string;
}

let renderKitHome: ((data: Record<string, unknown>) => string) | undefined;
let kitHomeCss = "";
let kitHomeScratch = "";

beforeAll(async () => {
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: Record<string, unknown>,
    ) => { js: { code: string }; css?: { code: string } };
  };
  const cssChunks: string[] = [];
  kitHomeScratch = mkdtempSync(join(tmpdir(), "authored-breaks-kit-home-"));
  const entry = join(kitHomeScratch, "entry.mjs");
  writeFileSync(
    entry,
    `
import { render } from "svelte/server";
import Page from ${JSON.stringify(join(root, "web/src/routes/+page.svelte"))};
export function renderPage(data) {
  const { head, body } = render(Page, { props: { data } });
  return "<head>" + head + "</head><body>" + body + "</body>";
}
`,
  );
  const outfile = join(kitHomeScratch, "bundle.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "web/node_modules"), join(root, "node_modules")],
    alias: { "#lib": join(root, "web/src/lib/") },
    plugins: [
      {
        name: "authored-breaks-kit-home-ssr",
        setup(plugin) {
          plugin.onLoad({ filter: /\.svelte$/ }, (args) => {
            const source = readFileSync(args.path, "utf8");
            const { js, css } = compile(source, {
              generate: "server",
              dev: false,
              filename: args.path,
            });
            if (css?.code) cssChunks.push(css.code);
            return { contents: js.code, loader: "js", resolveDir: dirname(args.path) };
          });
        },
      },
    ],
  });
  kitHomeCss = cssChunks.join("\n");
  const mod = (await import(pathToFileURL(outfile).href)) as {
    renderPage: (data: Record<string, unknown>) => string;
  };
  renderKitHome = mod.renderPage;
}, 60_000);
afterAll(() => {
  if (kitHomeScratch) rmSync(kitHomeScratch, { recursive: true, force: true });
});

function renderFeaturedKit(body: string): string {
  return renderKitHome!({
    session: null,
    sessionUnavailable: false,
    notice: null,
    joinResult: null,
    inviteUrl: "https://discord.gg/invite",
    appUrl: "https://next.example.test",
    counts: { memberCount: 42, onlineCount: 7, ranks: [] },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [
      { id: "f1", title: "Fixture feature", body, url: null, imageUrl: null, imageAlt: null },
    ],
    imageHosts: "",
    homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS },
  });
}

function kitGlobalExtras(extraCss = ""): { css: string; source: string }[] {
  return [
    { css: readFileSync(join(root, "web/src/app.css"), "utf8"), source: "web/src/app.css" },
    ...(extraCss ? [{ css: extraCss, source: "compiled component CSS" }] : []),
  ];
}

function featuredBody(html: string, rules: CssRule[], needles: string[]): Element {
  const doc = document(html);
  const items = elements(doc, (el) => attribute(el, "data-testid") === "featured-item");
  expect(items, "featured fixture reaches the homepage").toHaveLength(1);
  void rules;
  return smallestContaining(items[0]!, needles, "featured body");
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} featured body authored line breaks`, () => {
    const cases: { name: string; body: string; lines: string[]; wrap?: boolean }[] = [
      { name: "multi-paragraph", body: MULTI, lines: MULTI_LINES },
      { name: "single-line", body: SINGLE, lines: [SINGLE] },
      { name: "trailing-newline", body: TRAILING, lines: TRAILING_LINES },
      { name: "long unbroken word", body: LONG_WORD, lines: [LONG_WORD], wrap: true },
    ];
    for (const fixture of cases) {
      it(`renders ${fixture.name} featured text as authored`, () => {
        const html =
          twin === "Hono" ? renderFeaturedHono(fixture.body) : renderFeaturedKit(fixture.body);
        const rules = servedRules(html, twin === "Kit" ? kitGlobalExtras(kitHomeCss) : []);
        const needles = fixture.lines.filter(Boolean);
        const container = featuredBody(html, rules, needles);
        expectLines(container, fixture.lines, rules, `${twin} featured ${fixture.name}`, true);
        if (fixture.wrap) expectWrappable(container, rules, `${twin} featured ${fixture.name}`);
      });
    }

    it("never interprets featured text as markup and never autolinks it", () => {
      const html = twin === "Hono" ? renderFeaturedHono(HOSTILE) : renderFeaturedKit(HOSTILE);
      const rules = servedRules(html, twin === "Kit" ? kitGlobalExtras(kitHomeCss) : []);
      const container = featuredBody(html, rules, ["https://evil.example/x"]);
      expectPlainText(container, `${twin} hostile featured body`);
    });
  });
}

// ---------------------------------------------------------------------------
// Archive passages: real past-search route on both twins (proxy reads).
// ---------------------------------------------------------------------------
let archiveKit: Awaited<ReturnType<typeof compileArchiveKit>>;
beforeAll(async () => {
  archiveKit = await compileArchiveKit();
}, 60_000);
afterAll(() => archiveKit?.dispose());

function svelteStyleExtras(): { css: string; source: string }[] {
  // The route harness compiles Svelte without emitting component CSS; a fix
  // scoped in these components would still be served in production, so read
  // their <style> blocks as served sheets for the Kit twin.
  const files = [
    "web/src/lib/EventCard.svelte",
    "web/src/routes/events/past/+page.svelte",
    "web/src/lib/Shell.svelte",
  ];
  return files.flatMap((file) => {
    const source = readFileSync(join(root, file), "utf8");
    return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ({
      css: m[1]!,
      source: `${file} <style>`,
    }));
  });
}

describe.each(archiveTwins)("%s archive passage authored line breaks", (twin) => {
  beforeEach(() => {
    __resetAnonEventCacheForTests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ARCHIVE_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function passageFor(
    description: string,
    needles: string[],
  ): Promise<{ passage: Element; rules: CssRule[] }> {
    const source = archiveReadFixture();
    source.replaceRows([
      archiveRow(2, { eventKey: "archive-line-1", title: "Old game night", description }),
    ]);
    const response = await requestArchive(
      twin,
      `/events/past?${new URLSearchParams({ q: "needle" })}`,
      source.env,
      archiveKit,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    const rules = servedRules(
      html,
      twin === "Kit" ? [...kitGlobalExtras(), ...svelteStyleExtras()] : [],
    );
    const doc = document(html);
    const passages = elements(doc, (el) => classList(el).includes("archive-passage"));
    const passage = passages[0] ?? smallestContaining(doc, needles, `${twin} archive passage`);
    expect(passages.length, `${twin} archive passage renders for the match`).toBeLessThanOrEqual(1);
    return { passage, rules };
  }

  it("renders multi-paragraph passage lines and keeps its marks", async () => {
    const { passage, rules } = await passageFor(ARCHIVE_MULTI, ["Archive finale"]);
    expectLines(passage, ARCHIVE_MULTI_LINES, rules, `${twin} archive passage`);
    expect(tag(passage, "mark").map(text)).toEqual(["Needle"]);
  });

  it("leaves a single-line passage on one line", async () => {
    const { passage, rules } = await passageFor("Needle archive clue", ["Needle archive clue"]);
    expectLines(passage, ["Needle archive clue"], rules, `${twin} single-line archive passage`);
    expect(tag(passage, "mark").map(text)).toEqual(["Needle"]);
  });

  it("renders a trailing newline without inventing extra content", async () => {
    const { passage, rules } = await passageFor("Needle clue\nArchive finale\n", [
      "Archive finale",
    ]);
    expectLines(
      passage,
      ["Needle clue", "Archive finale"],
      rules,
      `${twin} trailing archive passage`,
    );
  });

  it("keeps a long unbroken word intact and wrappable", async () => {
    const body = `Needle ${LONG_TOKEN} end`;
    const { passage, rules } = await passageFor(body, [LONG_TOKEN]);
    expectLines(passage, [body], rules, `${twin} long-word archive passage`);
    expectWrappable(passage, rules, `${twin} long-word archive passage`);
  });

  it("never interprets passage text as markup and never autolinks it", async () => {
    const { passage } = await passageFor(
      "Needle <script>alert(1)</script> <b>bold</b> https://evil.example/x www.evil.example a@evil.example",
      ["https://evil.example/x"],
    );
    expectPlainText(passage, `${twin} hostile archive passage`);
    expect(tag(passage, "mark").map(text)).toEqual(["Needle"]);
  });
});

// ---------------------------------------------------------------------------
// CONTROL: the detail page already preserves authored breaks. If this
// passes while the card/featured/archive cases fail, the oracle is judging
// the served CSS — not merely echoing the fixture text.
// ---------------------------------------------------------------------------
describe("CONTROL event detail authored line breaks", () => {
  it("already renders multi-paragraph description lines", () => {
    const start = new Date("2030-01-10T20:00:00Z");
    const e: PublicEvent = {
      id: 1,
      icsSequence: 1n,
      eventKey: EVENT_KEY,
      title: "Chess night",
      game: "Chess",
      description: MULTI,
      startsAt: start,
      endsAt: new Date("2030-01-10T22:00:00Z"),
      timezone: "UTC",
      location: "Voice lobby",
      capacity: 10,
      status: "published",
      rsvpOpen: true,
      goingCount: 3,
      goingOccupancy: 3,
      discordEventId: null,
      discordSyncFailedAt: null,
      discordSyncFailureCode: null,
      agentGrantId: null,
      proofMarker: null,
      agentVersion: 1,
      createdBy: null,
      recurrenceFrequency: null,
      recurrenceCount: null,
      recurrenceEndsOn: null,
      parentEventId: null,
      recurrenceIndex: null,
      createdAt: start,
      updatedAt: start,
      syncRevision: 1,
      syncedRevision: 0,
    };
    const html = EventPage({
      e,
      neighbors: { previous: null, next: null },
      related: [],
      appUrl: "https://next.example.test",
      jsonLd: '{"@type":"Event"}',
    })!.toString() as string;
    const rules = servedRules(html);
    const container = smallestContaining(
      document(html),
      MULTI_LINES.filter(Boolean),
      "detail description",
    );
    expectLines(container, MULTI_LINES, rules, "CONTROL detail description");
  });
});
