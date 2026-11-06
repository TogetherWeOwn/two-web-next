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
// it renders the real pages and evaluates admitted linked and inline sheets
// in document order. Kit component fixtures additionally model compiled CSS
// as same-origin external output; they do not verify Vite asset URLs or order.
// Within its bounded CSS and CSP subset, it computes rendered lines: newlines
// count only when the effective CSS preserves them (white-space:
// pre/pre-wrap/pre-line/break-spaces, white-space-collapse: preserve*,
// from a matching rule, an inline style, or a utility class the served
// compiled sheet defines, resolved through the cascade); <br> and block
// boundaries always count. A fix in markup or in CSS can satisfy it; the
// current output, where newlines collapse, cannot.
//
// Hermetic: local component/route fixtures only, no database, no network.
// Run: npx vitest run test/authored-text-line-breaks-acceptance.test.ts
import { createHash } from "node:crypto";
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
import { securityHeadersFor } from "../src/headers";
import { FALLBACK_RANKS, HOME_JOIN_RESULT_COPY, HOME_NOTICES } from "../src/home-copy";
import { renderEventsHtml } from "../src/kit-events-html";
import { LEAF_CRITICAL_CSS } from "../src/leaf-critical-css";
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
// rendered tree, and resolve each judged property through the cascade
// (origin, importance, inline style, layers, specificity, order) and
// inheritance. It models a bounded subset of CSS exactly. Any selector,
// value, at-rule or stylesheet source outside that subset that could touch
// the judged properties throws "CSS oracle cannot evaluate": a guess in
// either direction (match or no match) can let a preserving rule win that a
// browser would discard.
// ---------------------------------------------------------------------------
type Longhand = "collapse" | "wrapMode" | "overflowWrap" | "wordBreak";
type Decl = { value: string; important: boolean };
type Specificity = [number, number, number];
type Simple =
  | { kind: "class" | "id"; name: string }
  | { kind: "attr"; name: string; op: string; value: string; flag: string }
  | { kind: "root" }
  | { kind: "is" | "where" | "not"; list: Complex[] };
type Compound = { tag: string; simples: Simple[]; pseudoElement: boolean };
type Complex = { compounds: Compound[]; combinators: string[] };
type CssRule = {
  selectors: { text: string; complex: Complex; spec: Specificity }[];
  declarations: Map<Longhand, Decl>;
  order: number;
  layer: number[];
  origin: number; // 0 user agent, 1 author
  source: string;
};

const unevaluable = (what: string): never => {
  throw new Error(`CSS oracle cannot evaluate ${what}; extend its explicit context`);
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

// Judged properties expand into the longhands a browser computes. The
// white-space shorthand sets both white-space-collapse and text-wrap-mode;
// word-wrap is the legacy alias of overflow-wrap.
const JUDGED =
  /(?:^|[\s;{])(?:white-space(?:-collapse)?|text-wrap(?:-mode)?|overflow-wrap|word-wrap|word-break)\s*:/i;
const INITIAL: Record<Longhand, string> = {
  collapse: "collapse",
  wrapMode: "wrap",
  overflowWrap: "normal",
  wordBreak: "normal",
};
const LONGHAND_VALUES: Record<Longhand, Set<string>> = {
  collapse: new Set(["collapse", "preserve", "preserve-breaks", "preserve-spaces", "break-spaces"]),
  wrapMode: new Set(["wrap", "nowrap"]),
  overflowWrap: new Set(["normal", "anywhere", "break-word"]),
  wordBreak: new Set(["normal", "break-all", "keep-all", "break-word", "auto-phrase"]),
};
const WHITE_SPACE: Record<string, [string, string]> = {
  normal: ["collapse", "wrap"],
  nowrap: ["collapse", "nowrap"],
  pre: ["preserve", "nowrap"],
  "pre-wrap": ["preserve", "wrap"],
  "pre-line": ["preserve-breaks", "wrap"],
  "break-spaces": ["break-spaces", "wrap"],
};
const TEXT_WRAP_STYLES = new Set(["auto", "balance", "pretty", "stable"]);
// inherit and unset both inherit: every judged longhand is inherited.
const GLOBAL_KEYWORDS = new Set(["inherit", "unset", "initial"]);

function expandDeclaration(prop: string, value: string, where: string): [Longhand, string][] {
  const longhands: Record<string, Longhand> = {
    "white-space-collapse": "collapse",
    "text-wrap-mode": "wrapMode",
    "overflow-wrap": "overflowWrap",
    "word-wrap": "overflowWrap",
    "word-break": "wordBreak",
  };
  const fail = () => unevaluable(`${prop}: ${value} (${where})`);
  if (!(prop in longhands) && prop !== "white-space" && prop !== "text-wrap") return [];
  if (GLOBAL_KEYWORDS.has(value)) {
    if (prop === "white-space")
      return [
        ["collapse", value],
        ["wrapMode", value],
      ];
    return [[prop === "text-wrap" ? "wrapMode" : longhands[prop]!, value]];
  }
  if (prop === "white-space") {
    const pair = WHITE_SPACE[value] ?? fail();
    return [
      ["collapse", pair[0]],
      ["wrapMode", pair[1]],
    ];
  }
  if (prop === "text-wrap") {
    const tokens = value.split(/\s+/);
    const modes = tokens.filter((t) => LONGHAND_VALUES.wrapMode.has(t));
    const styles = tokens.filter((t) => TEXT_WRAP_STYLES.has(t));
    if (modes.length > 1 || styles.length > 1 || modes.length + styles.length !== tokens.length)
      fail();
    return [["wrapMode", modes[0] ?? "wrap"]];
  }
  const longhand = longhands[prop]!;
  if (!LONGHAND_VALUES[longhand].has(value)) fail();
  return [[longhand, value]];
}

function parseDeclarations(body: string, where: string): Map<Longhand, Decl> {
  const declarations = new Map<Longhand, Decl>();
  for (const chunk of splitTopLevel(body, ";")) {
    const colon = chunk.indexOf(":");
    if (colon === -1) continue;
    const prop = chunk.slice(0, colon).trim().toLowerCase();
    let value = chunk.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "");
    value = value.trim().toLowerCase();
    for (const [longhand, resolved] of expandDeclaration(prop, value, where)) {
      // Within one block, a later declaration wins unless it would demote
      // an earlier !important one.
      const earlier = declarations.get(longhand);
      if (!earlier || important || !earlier.important)
        declarations.set(longhand, { value: resolved, important });
    }
  }
  return declarations;
}

// Selectors: type/universal, class, id, attribute (every operator and the
// i/s flags), :root, :is/:where/:not over complex selector lists, the
// descendant/child/adjacent/general-sibling combinators, and a trailing
// pseudo-element (which never matches the element itself).
const IDENT = /^(?:--|-?[A-Za-z_\u00a0-\uffff])[\w\u00a0-\uffff-]*/;
const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);
const ATTRIBUTE =
  /^\[\s*([A-Za-z_][\w-]*)\s*(?:([~|^$*]?=)\s*(?:"([^"\\]*)"|'([^'\\]*)'|((?:--|-?[A-Za-z_\u00a0-\uffff])[\w\u00a0-\uffff-]*))\s*(?:([iIsS])\s*)?)?\]/;

function parseSelector(text: string, where: string): Complex {
  const fail = (why: string): never => unevaluable(`selector ${text} (${why}; ${where})`);
  const s = text;
  let i = 0;
  const skipSpace = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const ident = (): string => {
    const m =
      IDENT.exec(s.slice(i)) ?? fail(`identifier expected at ${JSON.stringify(s.slice(i))}`);
    i += m[0].length;
    return m[0];
  };
  const compound = (nested: boolean): Compound => {
    const start = i;
    let tag = "*";
    if (s[i] === "*") i++;
    else if (IDENT.test(s.slice(i))) tag = ident().toLowerCase();
    const simples: Simple[] = [];
    let pseudoElement = false;
    for (;;) {
      const ch = s[i];
      if (ch !== "." && ch !== "#" && ch !== "[" && ch !== ":") break;
      if (pseudoElement) fail("nothing may follow a pseudo-element");
      if (ch === "." || ch === "#") {
        i++;
        simples.push({ kind: ch === "." ? "class" : "id", name: ident() });
      } else if (ch === "[") {
        const m = ATTRIBUTE.exec(s.slice(i)) ?? fail("unmodelled attribute selector");
        i += m[0].length;
        simples.push({
          kind: "attr",
          name: m[1]!.toLowerCase(),
          op: m[2] ?? "",
          value: m[3] ?? m[4] ?? m[5] ?? "",
          flag: (m[6] ?? "").toLowerCase(),
        });
      } else if (s[i + 1] === ":") {
        i += 2;
        ident();
        if (s[i] === "(") fail("functional pseudo-element");
        pseudoElement = true;
      } else {
        i++;
        const name = ident().toLowerCase();
        if (LEGACY_PSEUDO_ELEMENTS.has(name)) pseudoElement = true;
        else if (name === "root") simples.push({ kind: "root" });
        else if ((name === "is" || name === "where" || name === "not") && s[i] === "(") {
          i++;
          const inner = list(true);
          if (s[i] !== ")") fail(`unclosed :${name}()`);
          i++;
          simples.push({ kind: name, list: inner });
        } else fail(`unmodelled pseudo-class :${name}`);
      }
    }
    if (i === start) fail(`compound selector expected at ${JSON.stringify(s.slice(i))}`);
    if (pseudoElement && nested) fail("pseudo-element inside a selector argument");
    return { tag, simples, pseudoElement };
  };
  const complex = (nested: boolean): Complex => {
    skipSpace();
    const compounds = [compound(nested)];
    const combinators: string[] = [];
    for (;;) {
      const before = i;
      skipSpace();
      const ch = s[i];
      if (ch === undefined || ch === "," || ch === ")") break;
      let combinator = " ";
      if (ch === ">" || ch === "+" || ch === "~") {
        combinator = ch;
        i++;
        skipSpace();
      } else if (i === before) fail(`unexpected ${JSON.stringify(ch)}`);
      if (compounds[compounds.length - 1]!.pseudoElement)
        fail("pseudo-element before a combinator");
      combinators.push(combinator);
      compounds.push(compound(nested));
    }
    return { compounds, combinators };
  };
  const list = (nested: boolean): Complex[] => {
    const out = [complex(nested)];
    skipSpace();
    while (s[i] === ",") {
      i++;
      out.push(complex(nested));
      skipSpace();
    }
    return out;
  };
  const parsed = complex(false);
  skipSpace();
  if (i !== s.length) fail(`unexpected ${JSON.stringify(s.slice(i))}`);
  return parsed;
}

function specificity(complex: Complex): Specificity {
  let [ids, classes, types] = [0, 0, 0];
  for (const c of complex.compounds) {
    if (c.tag !== "*") types++;
    if (c.pseudoElement) types++;
    for (const simple of c.simples) {
      switch (simple.kind) {
        case "id":
          ids++;
          break;
        case "class":
        case "attr":
        case "root":
          classes++;
          break;
        case "is":
        case "not": {
          // The most specific argument counts; :where() counts nothing.
          const [a, b, c2] = simple.list.map(specificity).sort(compareSpecificity).at(-1)!;
          ids += a;
          classes += b;
          types += c2;
        }
      }
    }
  }
  return [ids, classes, types];
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// HTML attributes whose values selectors compare case-insensitively
// (HTML Standard, "Case-sensitivity of selectors").
const CASE_INSENSITIVE_ATTRIBUTES = new Set(
  (
    "accept accept-charset align alink axis bgcolor charset checked clear codetype color compact " +
    "declare defer dir direction disabled enctype face frame hreflang http-equiv lang language link " +
    "media method multiple nohref noresize noshade nowrap readonly rel rev rules scope scrolling " +
    "selected shape target text type valign valuetype vlink"
  ).split(" "),
);

function parentElement(el: Element): Element | null {
  const parent = (el as { parentNode?: DomNode | null }).parentNode;
  return parent && "tagName" in parent ? (parent as Element) : null;
}

function previousElement(el: Element): Element | null {
  const siblings = ((el as { parentNode?: { childNodes: DomNode[] } }).parentNode?.childNodes ??
    []) as DomNode[];
  for (let k = siblings.indexOf(el as DomNode) - 1; k >= 0; k--) {
    if ("tagName" in siblings[k]!) return siblings[k] as Element;
  }
  return null;
}

function quirksMode(el: Element): boolean {
  let node: DomNode = el;
  while ((node as { parentNode?: DomNode | null }).parentNode)
    node = (node as { parentNode: DomNode }).parentNode;
  return (node as { mode?: string }).mode === "quirks";
}

function classList(el: Element): string[] {
  return (attribute(el, "class") ?? "").split(/\s+/).filter(Boolean);
}

function ancestorsOf(el: Element): Element[] {
  const chain: Element[] = [];
  for (let node = parentElement(el); node; node = parentElement(node)) chain.push(node);
  return chain;
}

function matchAttr(el: Element, simple: Extract<Simple, { kind: "attr" }>): boolean {
  const actualRaw = el.attrs.find((attr) => attr.name.toLowerCase() === simple.name)?.value;
  if (actualRaw === undefined) return false;
  if (!simple.op) return true;
  const insensitive =
    simple.flag === "i" || (simple.flag === "" && CASE_INSENSITIVE_ATTRIBUTES.has(simple.name));
  const actual = insensitive ? actualRaw.toLowerCase() : actualRaw;
  const want = insensitive ? simple.value.toLowerCase() : simple.value;
  switch (simple.op) {
    case "=":
      return actual === want;
    case "~=":
      return want !== "" && !/\s/.test(want) && actual.split(/[ \t\n\f\r]+/).includes(want);
    case "|=":
      return actual === want || actual.startsWith(`${want}-`);
    case "^=":
      return want !== "" && actual.startsWith(want);
    case "$=":
      return want !== "" && actual.endsWith(want);
    default:
      return want !== "" && actual.includes(want);
  }
}

function matchSimple(el: Element, simple: Simple): boolean {
  switch (simple.kind) {
    case "class":
    case "id": {
      const names = simple.kind === "class" ? classList(el) : [attribute(el, "id") ?? ""];
      return quirksMode(el)
        ? names.some((name) => name.toLowerCase() === simple.name.toLowerCase())
        : names.includes(simple.name);
    }
    case "attr":
      return matchAttr(el, simple);
    case "root":
      return (el as { parentNode?: DomNode | null }).parentNode?.nodeName === "#document";
    case "not":
      return !simple.list.some((complex) => matchComplex(el, complex));
    default:
      return simple.list.some((complex) => matchComplex(el, complex));
  }
}

function matchCompound(el: Element, compound: Compound): boolean {
  if (compound.pseudoElement) return false;
  if (compound.tag !== "*" && el.tagName.toLowerCase() !== compound.tag) return false;
  return compound.simples.every((simple) => matchSimple(el, simple));
}

/** Right-to-left with backtracking: every candidate ancestor or sibling is
 * tried, not only the nearest one. */
function matchComplex(
  el: Element,
  complex: Complex,
  index = complex.compounds.length - 1,
): boolean {
  if (!matchCompound(el, complex.compounds[index]!)) return false;
  if (index === 0) return true;
  const combinator = complex.combinators[index - 1];
  const step = combinator === " " || combinator === ">" ? parentElement : previousElement;
  for (let next = step(el); next; next = step(next)) {
    if (matchComplex(next, complex, index - 1)) return true;
    if (combinator === ">" || combinator === "+") return false;
  }
  return false;
}

// Explicit desktop context: screen, 1280 × 800 CSS pixels. This bounded oracle
// understands media types, px width/height bounds, orientation, comma alternatives
// and whole-query negation. Supports queries cover the judged text properties.
// Unknown conditions affecting those properties fail loudly, never count as active.
const CSS_VIEWPORT = { width: 1280, height: 800 };
// A supports query is true exactly for the values this oracle evaluates.
const CSS_SUPPORT = new Map<string, Set<string>>([
  ["white-space", new Set(Object.keys(WHITE_SPACE))],
  ["white-space-collapse", LONGHAND_VALUES.collapse],
  ["text-wrap-mode", LONGHAND_VALUES.wrapMode],
  ["overflow-wrap", LONGHAND_VALUES.overflowWrap],
  ["word-wrap", LONGHAND_VALUES.overflowWrap],
  ["word-break", LONGHAND_VALUES.wordBreak],
]);

function mediaListActive(list: string, where: string): boolean {
  const unsupported = () => unevaluable(`@media ${list} (${where})`);
  if (list.trim() === "") return true;
  const alternatives = splitTopLevel(list.trim().toLowerCase(), ",").map((query) => {
    const negate = /^not\s+/.test(query.trim());
    const terms = query
      .trim()
      .replace(/^(not|only)\s+/, "")
      .split(/\s+and\s+/);
    const matches = terms.map((term, index) => {
      if (index === 0 && /^(all|screen|print)$/.test(term)) return term !== "print";
      const bound = /^\(\s*(?:(min|max)-)?(width|height)\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(term);
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

function activeCssGroup(prelude: string, source: string): boolean {
  if (/^@media\b/.test(prelude)) return mediaListActive(prelude.slice(6).trim(), source);
  if (/^@supports\b/.test(prelude)) {
    const condition = prelude.slice(9).trim().toLowerCase();
    const negate = /^not\s+/.test(condition);
    const declaration = /^\(\s*([\w-]+)\s*:\s*([\w-]+)\s*\)$/.exec(
      condition.replace(/^not\s+/, ""),
    );
    const values = declaration && CSS_SUPPORT.get(declaration[1]!);
    if (!values) return unevaluable(`${prelude} (${source})`);
    const active = values.has(declaration[2]!);
    return negate ? !active : active;
  }
  // Container dimensions, document conditions, scoping roots and every other
  // block at-rule are not available from the parsed fixture DOM. Refuse to
  // infer them from a selector or the viewport.
  return unevaluable(`${prelude} (${source})`);
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

// Cascade layers: a rule's layer key is the first-appearance rank of each
// enclosing layer, closed by Infinity (a layer's own rules beat its
// sublayers, and unlayered rules beat every layer, for normal declarations).
type CssState = { order: number; layers: Map<string, number>; anonymous: number };
type CssContext = {
  source: string;
  origin: number;
  layer: number[];
  layerName: string;
  conditional: boolean;
  state: CssState;
};

function registerLayer(ctx: CssContext, name: string): { layer: number[]; layerName: string } {
  const parts = name
    ? name.split(".").map((part) => part.trim())
    : [`<anonymous ${ctx.state.anonymous++}>`];
  let layerName = ctx.layerName;
  const layer = [...ctx.layer];
  for (const part of parts) {
    if (name && !IDENT.test(part)) unevaluable(`@layer ${name} (${ctx.source})`);
    layerName = layerName ? `${layerName}.${part}` : part;
    if (!ctx.state.layers.has(layerName)) ctx.state.layers.set(layerName, ctx.state.layers.size);
    layer.push(ctx.state.layers.get(layerName)!);
  }
  return { layer, layerName };
}

function parseCss(css: string, ctx: CssContext, out: CssRule[]): void {
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
      const statement = clean.slice(i, semi).trim();
      i = semi + 1;
      if (/^@layer\b/i.test(statement)) {
        if (ctx.conditional) unevaluable(`${statement} inside a conditional group (${ctx.source})`);
        for (const name of statement.slice(6).split(",")) registerLayer(ctx, name.trim());
      } else if (statement.startsWith("@") && !/^@charset\b/i.test(statement)) {
        // @import pulls in rules the oracle cannot see; @namespace changes
        // what type selectors mean.
        unevaluable(`${statement} (${ctx.source})`);
      }
      continue;
    }
    if (brace === -1) break;
    const prelude = clean.slice(i, brace).trim();
    const block = readBlock(clean, brace);
    i = block.end + 1;
    if (/^@layer\b/i.test(prelude)) {
      if (ctx.conditional) unevaluable(`${prelude} inside a conditional group (${ctx.source})`);
      parseCss(block.content, { ...ctx, ...registerLayer(ctx, prelude.slice(6).trim()) }, out);
    } else if (prelude.startsWith("@")) {
      if (JUDGED.test(block.content) && activeCssGroup(prelude, ctx.source)) {
        parseCss(block.content, { ...ctx, conditional: true }, out);
      }
    } else if (/[{}]/.test(block.content)) {
      if (JUDGED.test(block.content)) unevaluable(`nested rules in ${prelude} (${ctx.source})`);
    } else {
      const declarations = parseDeclarations(block.content, ctx.source);
      if (declarations.size === 0) continue;
      out.push({
        selectors: splitTopLevel(prelude, ",").map((piece) => {
          const text = piece.trim();
          const complex = parseSelector(text, ctx.source);
          return { text, complex, spec: specificity(complex) };
        }),
        declarations,
        order: ctx.state.order++,
        layer: [...ctx.layer, Number.POSITIVE_INFINITY],
        origin: ctx.origin,
        source: ctx.source,
      });
    }
  }
}

// The user-agent rules (and nowrap presentational hints) that set the judged
// properties on HTML elements.
const USER_AGENT_CSS =
  "pre, listing, plaintext, xmp { white-space: pre; } textarea { white-space: pre-wrap; } " +
  "nobr, td[nowrap], th[nowrap] { white-space: nowrap; }";

type CssExtra = { css: string; source: string; kind?: "kit-external" };
type StylePolicy = { self: boolean; hashes: Set<string> };
type ServedRules = CssRule[] & { stylePolicies: StylePolicy[] | null };

// This fixture models only same-origin links and SHA-256 inline hashes. Every
// enforced policy must admit a source; unmodelled source expressions and
// directives that change stylesheet admission are refused, not approximated.
function stylesheetPolicies(headers: Headers): StylePolicy[] {
  const csp = headers.get("content-security-policy");
  if (!csp) return unevaluable("missing response Content-Security-Policy");
  if (/[^\t\x20-\x7e]/.test(csp)) unevaluable("non-ASCII or control character in CSP");
  return csp.split(",").map((policy) => {
    const directives = new Map<string, string[]>();
    for (const part of policy.split(";")) {
      const tokens = part.split(/[ \t]+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const name = tokens.shift()!.toLowerCase();
      if (directives.has(name)) unevaluable(`duplicate CSP directive ${name}`);
      directives.set(name, tokens);
    }
    for (const name of [
      "style-src-elem",
      "style-src-attr",
      "sandbox",
      "require-sri-for",
      "upgrade-insecure-requests",
    ]) {
      if (directives.has(name)) unevaluable(`CSP ${name}`);
    }
    const sources = directives.get("style-src") ?? directives.get("default-src");
    if (!sources || sources.length === 0) return unevaluable("CSP stylesheet source list");
    const hashes = new Set<string>();
    for (const source of sources) {
      if (source === "'self'" || source === "'none'") continue;
      if (/^'sha256-[A-Za-z0-9+/]{43}='$/.test(source)) hashes.add(source.slice(8, -1));
      else unevaluable(`CSP stylesheet source ${source}`);
    }
    if (sources.includes("'none'") && sources.length !== 1)
      unevaluable("CSP 'none' combined with other stylesheet sources");
    return { self: sources.includes("'self'"), hashes };
  });
}

function routePolicy(path: string): Headers {
  return new Headers(securityHeadersFor({ path, method: "GET" }));
}

/** Kit extras are compiled CSS represented as same-origin external output,
 * not as inline styles. The fixture does not prove final Vite asset URLs or
 * bundling/order; it admits these extras only under a same-origin policy. */
function servedRules(
  html: string,
  extras: CssExtra[],
  admission: Headers | "synthetic",
): ServedRules {
  const policies = admission === "synthetic" ? null : stylesheetPolicies(admission);
  const rules: ServedRules = Object.assign([] as CssRule[], { stylePolicies: policies });
  const state: CssState = { order: 0, layers: new Map(), anonymous: 0 };
  const context = (source: string, origin: number): CssContext => ({
    source,
    origin,
    layer: [],
    layerName: "",
    conditional: false,
    state,
  });
  parseCss(USER_AGENT_CSS, context("user-agent sheet", 0), rules);
  const chunks: { css: string; source: string }[] = [];
  const doc = document(html);
  if (
    elements(
      doc,
      (e) =>
        e.tagName === "meta" &&
        (attribute(e, "http-equiv") ?? "").toLowerCase() === "content-security-policy",
    ).length > 0
  )
    unevaluable("meta Content-Security-Policy (stylesheet admission)");
  const hasBaseHref =
    elements(doc, (e) => e.tagName === "base" && attribute(e, "href") !== undefined).length > 0;
  for (const el of elements(doc, (e) => e.tagName === "style" || e.tagName === "link")) {
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml")
      unevaluable(`foreign stylesheet element <${el.tagName}>`);
    if (el.attrs.some((attr) => attr.name.startsWith("on")))
      unevaluable(`event handler on <${el.tagName}> (dynamic stylesheet admission)`);
    const relTokens = (attribute(el, "rel") ?? "").split(/[\t\n\f\r ]+/);
    const rel = relTokens.map((token) => token.toLowerCase());
    if (el.tagName === "link" && !rel.includes("stylesheet")) continue;
    const title = attribute(el, "title");
    if (title) unevaluable(`stylesheet title ${JSON.stringify(title)} (preferred sets)`);
    const type = attribute(el, "type");
    if (type && !/^text\/css$/i.test(type)) {
      // Links parse MIME parameters/whitespace differently from <style>.
      // Do not silently discard a potentially active collapsing sheet.
      if (el.tagName === "link" && /[;\t\n\f\r ]/.test(type))
        unevaluable(`stylesheet type ${JSON.stringify(type)} (MIME parsing)`);
      continue;
    }
    const media = attribute(el, "media");
    if (media !== undefined && /[^\t\n\f\r\x20-\x7e]/.test(media))
      unevaluable(`stylesheet media ${JSON.stringify(media)} (CSS tokenization)`);
    if (el.tagName === "style") {
      if (media === undefined || mediaListActive(media, "<style media>")) {
        if (attribute(el, "nonce") !== undefined) unevaluable("inline stylesheet nonce");
        const css = text(el);
        const hash = createHash("sha256").update(css, "utf8").digest("base64");
        if (!policies || policies.every((policy) => policy.hashes.has(hash)))
          chunks.push({ css, source: "inline <style>" });
      }
      continue;
    }
    if (rel.includes("alternate")) {
      // Alternate activation has browser-sensitive casing; the controls
      // admit only the canonical lowercase token as deterministically inert.
      if (!relTokens.includes("alternate")) unevaluable("noncanonical alternate stylesheet rel");
      continue;
    }
    if (attribute(el, "disabled") !== undefined) continue;
    const href = attribute(el, "href") ?? "";
    if (!href) continue;
    if (media !== undefined && !mediaListActive(media, href)) continue;
    if (hasBaseHref) unevaluable("<base href> (stylesheet URL resolution)");
    if (attribute(el, "integrity")) unevaluable("stylesheet integrity (served-byte admission)");
    if (attribute(el, "nonce") !== undefined) unevaluable("linked stylesheet nonce");
    const path = href.split(/[?#]/)[0]!;
    if (!/^\/(?:[\w-]+\/)*[\w.-]+\.css$/.test(path))
      unevaluable(`stylesheet ${JSON.stringify(href)} (only canonical public/ CSS is readable)`);
    if (policies && !policies.every((policy) => policy.self)) continue;
    try {
      chunks.push({ css: readFileSync(join(root, "public", path), "utf8"), source: path });
    } catch {
      unevaluable(`unreadable stylesheet ${JSON.stringify(path)}`);
    }
  }
  for (const extra of extras) {
    if (policies && extra.kind !== "kit-external")
      unevaluable(`unidentified stylesheet extra ${extra.source}`);
    if (!policies || policies.every((policy) => policy.self)) chunks.push(extra);
  }
  for (const chunk of chunks) parseCss(chunk.css, context(chunk.source, 1), rules);
  return rules;
}

function compareLayers(a: number[], b: number[]): number {
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    if (a[k] !== b[k]) return (a[k] ?? -1) < (b[k] ?? -1) ? -1 : 1;
  }
  return 0;
}

type Effective = { value: string; via: string };

/** The cascaded value of one longhand on one element, or null if no
 * declaration applies to it. */
function cascaded(el: Element, rules: CssRule[], longhand: Longhand): Effective | null {
  type Candidate = Decl & {
    inline: boolean;
    origin: number;
    layer: number[];
    spec: Specificity;
    order: number;
    via: string;
  };
  const candidates: Candidate[] = [];
  const style = attribute(el, "style");
  const policies = (rules as ServedRules).stylePolicies;
  if (policies === undefined) unevaluable("stylesheet admission metadata");
  const inline =
    style &&
    policies === null &&
    parseDeclarations(style, `inline style on <${el.tagName}>`).get(longhand);
  if (inline) {
    candidates.push({
      ...inline,
      inline: true,
      origin: 1,
      layer: [],
      spec: [0, 0, 0],
      order: 0,
      via: `inline style on <${el.tagName}>`,
    });
  }
  for (const rule of rules) {
    const decl = rule.declarations.get(longhand);
    if (!decl) continue;
    for (const selector of rule.selectors) {
      if (matchComplex(el, selector.complex)) {
        candidates.push({
          ...decl,
          inline: false,
          origin: rule.origin,
          layer: rule.layer,
          spec: selector.spec,
          order: rule.order,
          via: `${selector.text} (${rule.source})`,
        });
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.important !== b.important) return a.important ? -1 : 1;
    const reverse = a.important ? -1 : 1; // important origins and layers win in reverse
    return (
      reverse * (b.origin - a.origin) ||
      Number(b.inline) - Number(a.inline) ||
      reverse * compareLayers(b.layer, a.layer) ||
      compareSpecificity(b.spec, a.spec) ||
      b.order - a.order
    );
  });
  return { value: candidates[0]!.value, via: candidates[0]!.via };
}

/** The computed value: cascaded, else inherited (every judged longhand is
 * inherited), else initial. */
function computedValue(el: Element, rules: CssRule[], longhand: Longhand): Effective {
  for (let node: Element | null = el; node; node = parentElement(node)) {
    const winner = cascaded(node, rules, longhand);
    if (!winner || winner.value === "inherit" || winner.value === "unset") continue;
    if (winner.value === "initial")
      return { value: INITIAL[longhand], via: `initial via ${winner.via}` };
    return winner;
  }
  return { value: INITIAL[longhand], via: "initial value" };
}

const PRESERVED_BREAKS = new Set(["preserve", "preserve-breaks", "break-spaces"]);

function preservesBreaks(el: Element, rules: CssRule[]): { preserved: boolean; detail: string } {
  const collapse = computedValue(el, rules, "collapse");
  return {
    preserved: PRESERVED_BREAKS.has(collapse.value),
    detail: `white-space-collapse: ${collapse.value} via ${collapse.via}`,
  };
}

function wrapsLongWords(el: Element, rules: CssRule[]): { wraps: boolean; detail: string } {
  const mode = computedValue(el, rules, "wrapMode");
  if (mode.value !== "wrap")
    return { wraps: false, detail: `text-wrap-mode: ${mode.value} via ${mode.via}` };
  const wrap = computedValue(el, rules, "overflowWrap");
  if (wrap.value === "anywhere" || wrap.value === "break-word")
    return { wraps: true, detail: `overflow-wrap: ${wrap.value} via ${wrap.via}` };
  const wordBreak = computedValue(el, rules, "wordBreak");
  if (wordBreak.value === "break-all" || wordBreak.value === "break-word")
    return { wraps: true, detail: `word-break: ${wordBreak.value} via ${wordBreak.via}` };
  return { wraps: false, detail: `overflow-wrap: ${wrap.value} via ${wrap.via}` };
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
  // Each text run follows its own element's computed white-space, so a
  // descendant that collapses cannot hide behind a preserving container.
  const preserving = new Map<Element, boolean>();
  const preserves = (el: Element) => {
    if (!preserving.has(el)) preserving.set(el, preservesBreaks(el, rules).preserved);
    return preserving.get(el)!;
  };
  let out = "";
  const walk = (node: DomNode, parent: Element): void => {
    if (node.nodeName === "#text") {
      const value = (node as { value: string }).value;
      out += preserves(parent) ? value : value.replace(/\s+/g, " ");
      return;
    }
    if (!("tagName" in node)) {
      if ("childNodes" in node) for (const child of node.childNodes) walk(child as DomNode, parent);
      return;
    }
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName) || attribute(el, "hidden") !== undefined) return;
    if (skipHeadings && /^h[1-6]$/.test(el.tagName)) return;
    if (el.tagName === "br") {
      out += "\n";
      return;
    }
    const block = BLOCK_TAGS.has(el.tagName);
    if (block) out += "\n\n";
    for (const child of el.childNodes) walk(child as DomNode, el);
    if (block) out += "\n\n";
  };
  for (const child of container.childNodes) walk(child as DomNode, container);
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

/** Smallest (by inclusion, then text size) rendered element under root
 * whose text contains every needle — the authored-text container, whatever
 * markup the implementation chooses for it. A hidden copy is never judged in
 * place of the text a reader sees. */
function smallestContaining(rootEl: DomNode, needles: string[], label: string): Element {
  const candidates = elements(
    rootEl,
    (el) =>
      !SKIP_TAGS.has(el.tagName) &&
      ![el, ...ancestorsOf(el)].some((node) => attribute(node, "hidden") !== undefined) &&
      needles.every((n) => text(el).includes(n)),
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
    return renderedLines(container, servedRules(html, [], "synthetic"));
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
// Oracle fidelity controls: every selector, cascade and stylesheet-source
// shape the oracle accepts is evaluated the way a browser would, and every
// shape it does not model fails loudly. A guess in either direction can let
// a preserving rule win that a browser would discard, so neither "no match"
// nor "match" is a safe default for unmodelled syntax.
// ---------------------------------------------------------------------------
describe("CSS oracle selector, cascade and source fidelity controls", () => {
  const COLLAPSED = ["Doors at seven Bring a deck New players welcome"];
  const featured = (inner = `<p>${MULTI}</p>`) =>
    `<main class="content-theme"><h2 class="lead">Featured</h2>` +
    `<article id="feature" data-testid="featured-item"><span class="kicker">New</span><em>!</em>${inner}</article></main>`;

  function linesIn(html: string, extras: { css: string; source: string }[] = []): string[] {
    const container = smallestContaining(document(html), MULTI_LINES.filter(Boolean), "control");
    return renderedLines(container, servedRules(html, extras, "synthetic"));
  }
  const linesWith = (css: string, inner?: string) =>
    linesIn(`<style>${css}</style>${featured(inner)}`);
  const preserving = (selector: string) => `${selector} { white-space: pre-line; }`;

  describe("sibling and nested combinators", () => {
    it.each([
      "[data-testid='featured-item'] + p",
      "[data-testid='featured-item'] ~ p",
      ".content-theme + article p",
      ".content-theme ~ * p",
      ".kicker + p",
      ".lead + p",
      ".lead ~ p",
    ])("rejects a sibling form that cannot reach the paragraph: %s", (selector) => {
      expect(linesWith(preserving(selector))).toEqual(COLLAPSED);
    });

    it.each([
      ".kicker ~ p",
      "em + p",
      ".kicker + em + p",
      ".lead + [data-testid='featured-item'] > p",
      ".lead ~ article p",
    ])("admits a sibling form that reaches the paragraph: %s", (selector) => {
      expect(linesWith(preserving(selector))).toEqual(MULTI_LINES);
    });

    it("finds a farther ancestor when the nearest one cannot satisfy the next combinator", () => {
      expect(
        linesWith(preserving(".content-theme > * p"), `<section><p>${MULTI}</p></section>`),
      ).toEqual(MULTI_LINES);
    });
  });

  describe(":not() and :is() arguments", () => {
    it.each([
      "[data-testid='featured-item'] p:not(main p)",
      "p:not(.content-theme > article > p)",
      ":is(aside p)",
      "p:not(em + p)",
    ])("evaluates a complex argument against the real tree and rejects: %s", (selector) => {
      expect(linesWith(preserving(selector))).toEqual(COLLAPSED);
    });

    it.each([
      "p:not(aside p)",
      ":is(main p)",
      ":is(.content-theme article) > p",
      "p:not(.kicker + p)",
    ])("evaluates a complex argument against the real tree and admits: %s", (selector) => {
      expect(linesWith(preserving(selector))).toEqual(MULTI_LINES);
    });

    it.each([
      "[data-testid='featured-item'] p:not(:has(span))",
      "[data-testid='featured-item'] p:not(:hover)",
      "[data-testid='featured-item'] p:not(:first-child)",
      "[data-testid='featured-item'] p:not(::before)",
      "[data-testid='featured-item'] p:not(.missing, :focus-visible)",
      "[data-testid='featured-item'] p:has(span)",
      ":is(:hover, main) p",
    ])("fails closed on a pseudo-class it cannot evaluate: %s", (selector) => {
      expect(() => linesWith(preserving(selector))).toThrow("CSS oracle cannot evaluate");
    });
  });

  describe("unmodelled selector syntax", () => {
    it.each([
      "[data-testid='featured-item'] p, p:bogus-state",
      "svg|p",
      ".content\\-theme p",
      "& p",
      "[data-testid=='featured-item'] p",
      "> p",
      "p ~",
      "p::first-line span",
    ])("fails closed rather than guessing: %s", (selector) => {
      expect(() => linesWith(preserving(selector))).toThrow("CSS oracle cannot evaluate");
    });

    it("never applies a pseudo-element rule to the element itself", () => {
      expect(linesWith(preserving("[data-testid='featured-item'] p::first-line"))).toEqual(
        COLLAPSED,
      );
    });
  });

  describe("attribute selectors", () => {
    it.each([
      "[data-testid^='feat'] p",
      "[data-testid$='-item'] p",
      "[data-testid*='ured-it'] p",
      "[data-testid|='featured'] p",
      "[data-testid='FEATURED-ITEM' i] p",
      "[class~='content-theme'] p",
      "[data-testid=featured-item] p",
      "[DATA-TESTID='featured-item'] p",
    ])("admits a matching attribute operator: %s", (selector) => {
      expect(linesWith(preserving(selector))).toEqual(MULTI_LINES);
    });

    it.each([
      "[data-testid^='item'] p",
      "[data-testid$='feat'] p",
      "[data-testid*='xyz'] p",
      "[data-testid|='feat'] p",
      "[data-testid='FEATURED-ITEM'] p",
      "[data-testid='FEATURED-ITEM' s] p",
      "[data-testid~='featured'] p",
      "[data-testid^=''] p",
    ])("rejects a nonmatching attribute operator: %s", (selector) => {
      expect(linesWith(preserving(selector))).toEqual(COLLAPSED);
    });

    it("lets a more specific collapsing rule written with an operator win", () => {
      expect(
        linesWith(
          `${preserving("[data-testid='featured-item'] p")} main [data-testid^='feat'] p { white-space: normal; }`,
        ),
      ).toEqual(COLLAPSED);
    });
  });

  describe("specificity", () => {
    it.each([
      [
        ":where() contributes nothing",
        `${preserving(":where(.content-theme) [data-testid='featured-item'] p")} main [data-testid='featured-item'] p { white-space: normal; }`,
      ],
      [
        ":not() counts only its argument",
        `${preserving("[data-testid='featured-item'] p:not(.x)")} .content-theme [data-testid='featured-item'] p { white-space: normal; }`,
      ],
      [
        ":is() counts its most specific argument only",
        `${preserving(":is(.content-theme, #feature) p")} #feature p { white-space: normal; }`,
      ],
      [
        "classes never outrank an id",
        `#feature p { white-space: normal; } ${preserving(`${".content-theme".repeat(11)} p`)}`,
      ],
      [
        "attribute values are not selectors",
        `${preserving("[data-testid='featured-item'] p:not([title='#x .y z'])")} .content-theme [data-testid='featured-item'] p { white-space: normal; }`,
      ],
    ])("resolves the cascade by real specificity: %s", (_label, css) => {
      expect(linesWith(css)).toEqual(COLLAPSED);
    });
  });

  describe("cascade order, importance and layers", () => {
    it.each([
      [
        "an important rule beats a normal inline style",
        "p { white-space: normal !important; }",
        `<p style="white-space: pre-line">${MULTI}</p>`,
      ],
      [
        "unlayered rules beat layered ones of any specificity",
        `@layer base { ${preserving("#feature[data-testid='featured-item'] p")} } article p { white-space: normal; }`,
        undefined,
      ],
      [
        "a later white-space shorthand resets an earlier collapse longhand",
        `[data-testid='featured-item'] p { white-space-collapse: preserve-breaks; } [data-testid='featured-item'] p { white-space: normal; }`,
        undefined,
      ],
      [
        "a more specific collapse longhand beats the shorthand",
        `${preserving("[data-testid='featured-item'] p")} .content-theme [data-testid='featured-item'] p { white-space-collapse: collapse; }`,
        undefined,
      ],
      [
        "declaration order inside one block",
        `[data-testid='featured-item'] p { white-space-collapse: preserve-breaks; white-space: normal; }`,
        undefined,
      ],
      [
        "a supports query names a value the oracle itself evaluates",
        `${preserving("[data-testid='featured-item'] p")} @supports (white-space-collapse: break-spaces) { #feature p { white-space: normal; } }`,
        undefined,
      ],
      [
        "initial resets an inherited value",
        `.content-theme { white-space: pre-line; } article { white-space: initial; }`,
        undefined,
      ],
    ])("collapses when %s", (_label, css, inner) => {
      expect(linesWith(css, inner)).toEqual(COLLAPSED);
    });

    it.each([
      [
        "an important inline style beats an important rule",
        "#feature p { white-space: normal !important; }",
        `<p style="white-space: pre-line !important">${MULTI}</p>`,
      ],
      [
        "a later layer beats an earlier one of higher specificity",
        `@layer a, b; @layer b { ${preserving("article p")} } @layer a { #feature p { white-space: normal; } }`,
        undefined,
      ],
      [
        "a layer's own rules beat its sublayers",
        `@layer a { @layer inner { #feature p { white-space: normal; } } ${preserving("article p")} }`,
        undefined,
      ],
      [
        "important layered rules beat important unlayered ones",
        `@layer a { article p { white-space: pre-line !important; } } #feature p { white-space: normal !important; }`,
        undefined,
      ],
      [
        "inherit takes the parent value",
        `.content-theme { white-space: pre-line; } article { white-space: inherit; }`,
        undefined,
      ],
      [
        "unset inherits an inherited property",
        `.content-theme { white-space: pre-line; } article { white-space: unset; }`,
        undefined,
      ],
      ["the user-agent pre element preserves", "", `<pre>${MULTI}</pre>`],
    ])("preserves when %s", (_label, css, inner) => {
      expect(linesWith(css, inner)).toEqual(MULTI_LINES);
    });

    it.each([
      "white-space: var(--ws)",
      "white-space: revert",
      "white-space: revert-layer",
      "white-space: pre-lines",
      "overflow-wrap: env(x)",
    ])("fails closed on a value it cannot resolve: %s", (declaration) => {
      expect(() => linesWith(`[data-testid='featured-item'] p { ${declaration}; }`)).toThrow(
        "CSS oracle cannot evaluate",
      );
    });

    it("judges each text run by its own element, not only the container", () => {
      expect(
        linesWith(
          `${preserving("[data-testid='featured-item'] p")} p span { white-space: normal; }`,
          "<p>Doors at seven\n<span>Bring a deck\n\nNew players</span> welcome</p>",
        ),
      ).toEqual(["Doors at seven", "Bring a deck New players welcome"]);
    });
  });

  describe("long-word wrapping", () => {
    function wraps(css: string, inner = `<p>${LONG_WORD}</p>`): boolean {
      const html = `<style>${css}</style>${featured(inner)}`;
      const container = smallestContaining(document(html), [LONG_TOKEN], "wrap control");
      return wrapsLongWords(container, servedRules(html, [], "synthetic")).wraps;
    }
    const p = "[data-testid='featured-item'] p";

    it.each([
      ["white-space: pre disables wrapping", `${p} { white-space: pre; overflow-wrap: anywhere; }`],
      [
        "text-wrap-mode: nowrap",
        `${p} { white-space: pre-line; overflow-wrap: anywhere; text-wrap-mode: nowrap; }`,
      ],
      [
        "text-wrap: nowrap",
        `${p} { white-space: pre-line; overflow-wrap: anywhere; text-wrap: nowrap; }`,
      ],
      [
        "the word-wrap alias overrides",
        `${p} { overflow-wrap: anywhere; } #feature p { word-wrap: normal; }`,
      ],
      ["the user-agent nobr element", `${p} { overflow-wrap: anywhere; }`],
    ])("does not wrap when %s", (label, css) => {
      const inner = label.includes("nobr") ? `<p><nobr>${LONG_WORD}</nobr></p>` : undefined;
      expect(wraps(css, inner)).toBe(false);
    });

    it.each([
      ["pre-line with overflow-wrap", `${p} { white-space: pre-line; overflow-wrap: anywhere; }`],
      ["the word-wrap alias", `${p} { white-space: pre-line; word-wrap: break-word; }`],
      [
        "text-wrap: balance keeps wrapping",
        `${p} { overflow-wrap: anywhere; text-wrap: balance; }`,
      ],
    ])("wraps with %s", (_label, css) => {
      expect(wraps(css)).toBe(true);
    });
  });

  describe("stylesheet sources", () => {
    const eventMarkup = `<div class="event-theme"><div class="event-description"><p>${MULTI}</p></div></div>`;

    it.each([
      [
        "a non-CSS style element",
        `<style type="text/plain">${preserving("[data-testid='featured-item'] p")}</style>${featured()}`,
      ],
      [
        "a non-CSS linked sheet",
        `<link rel="stylesheet" type="text/plain" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a print-only style element",
        `<style media="print">${preserving("p")}</style>${featured()}`,
      ],
      [
        "a style element inside a template",
        `<template><style>${preserving("p")}</style></template>${featured()}`,
      ],
      [
        "a link inside a template",
        `<template><link rel="stylesheet" href="/event-theme.css"></template>${eventMarkup}`,
      ],
      [
        "a style inside head noscript with scripting enabled",
        `<head><noscript><style>${preserving("p")}</style></noscript></head><body>${featured()}</body>`,
      ],
      [
        "a link inside head noscript with scripting enabled",
        `<head><noscript><link rel="stylesheet" href="/event-theme.css"></noscript></head><body>${eventMarkup}</body>`,
      ],
      [
        "a style inside body noscript with scripting enabled",
        `<body><noscript><style>${preserving("p")}</style></noscript>${featured()}</body>`,
      ],
      [
        "a link inside body noscript with scripting enabled",
        `<body><noscript><link rel="stylesheet" href="/event-theme.css"></noscript>${eventMarkup}</body>`,
      ],
      [
        "a padded inline CSS type",
        `<style type=" text/css ">${preserving("p")}</style>${featured()}`,
      ],
      [
        "an inline CSS type with MIME parameters",
        `<style type="text/css; charset=utf-8">${preserving("p")}</style>${featured()}`,
      ],
      [
        "a print-only linked sheet",
        `<link rel="stylesheet" href="/event-theme.css" media="print">${eventMarkup}`,
      ],
      [
        "a linked sheet outside the explicit screen width",
        `<link rel="stylesheet" href="/event-theme.css" media="screen and (max-width: 1px)">${eventMarkup}`,
      ],
      ["a link with no href", `<link rel="stylesheet">${eventMarkup}`],
      ["a link with an empty href", `<link rel="stylesheet" href="">${eventMarkup}`],
      [
        "a preload without a stylesheet relation",
        `<link rel="preload" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a non-ASCII rel separator",
        `<link rel="stylesheet preload" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a vertical-tab rel separator",
        `<link rel="stylesheet\u000bpreload" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a disabled linked sheet",
        `<link rel="stylesheet" href="/event-theme.css" disabled>${eventMarkup}`,
      ],
      [
        "an alternate linked sheet",
        `<link rel="alternate stylesheet" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a stylesheet with the alternate token last",
        `<link rel="stylesheet alternate" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a boolean disabled attribute spelled false",
        `<link rel="stylesheet" disabled="false" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a utility class name with no served utility CSS",
        featured(`<p class="whitespace-pre-line">${MULTI}</p>`),
      ],
      [
        "a hidden preserved copy beside the visible text",
        `<style>${preserving("p[hidden]")}</style>${featured(`<p hidden>${MULTI}</p><p>${MULTI}</p>`)}`,
      ],
    ])("does not let %s preserve breaks", (_label, html) => {
      expect(linesIn(html)).toEqual(COLLAPSED);
    });

    it.each([
      [
        "a screen style element",
        `<style media="screen and (min-width: 1280px)">${preserving("p")}</style>${featured()}`,
      ],
      ["a linked sheet", `<link rel="stylesheet" href="/event-theme.css">${eventMarkup}`],
      [
        "an all-media linked sheet",
        `<link rel="stylesheet preload" href="/event-theme.css" media="all">${eventMarkup}`,
      ],
      [
        "an empty-media linked sheet",
        `<link rel="stylesheet" href="/event-theme.css" media="">${eventMarkup}`,
      ],
      [
        "an ASCII-whitespace-separated uppercase stylesheet relation",
        `<link REL=" PRELOAD\tSTYLESHEET\n" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a versioned local sheet",
        `<link rel="stylesheet" href="/event-theme.css?v=1#rules">${eventMarkup}`,
      ],
      [
        "a target-only base that cannot change stylesheet resolution",
        `<base target="_blank"><link rel="stylesheet" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "an inline sheet with an ignored disabled content attribute",
        `<style disabled>${preserving("p")}</style>${featured()}`,
      ],
      [
        "a titled calendar feed beside the active CSS",
        `<link rel="alternate" type="text/calendar" title="Events" href="/events.ics"><style>${preserving("p")}</style>${featured()}`,
      ],
      [
        "a titled icon beside the active CSS",
        `<link rel="icon" title="Site icon" href="/favicon.ico"><style>${preserving("p")}</style>${featured()}`,
      ],
    ])("lets %s preserve breaks", (_label, html) => {
      expect(linesIn(html)).toEqual(MULTI_LINES);
    });

    it.each(["text/css", "TEXT/CSS", ""])("admits the CSS type %j on style and link", (type) => {
      expect(linesIn(`<style type="${type}">${preserving("p")}</style>${featured()}`)).toEqual(
        MULTI_LINES,
      );
      expect(
        linesIn(`<link rel="stylesheet" type="${type}" href="/event-theme.css">${eventMarkup}`),
      ).toEqual(MULTI_LINES);
    });

    it("ignores a non-CSS collapsing mutant over a served preserving sheet", () => {
      const html =
        `<link rel="stylesheet" href="/event-theme.css">` +
        `<style type="text/plain">.event-theme .event-description p { white-space: normal !important; }</style>` +
        eventMarkup;
      expect(linesIn(html)).toEqual(MULTI_LINES);
    });

    it.each([
      [
        "two preferred linked stylesheet sets",
        `<link rel="stylesheet" title="first" href="/schedule-theme.css"><link rel="stylesheet" title="second" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a titled inline stylesheet",
        `<style title="preferred">${preserving("p")}</style>${featured()}`,
      ],
      [
        "a whitespace-only stylesheet title",
        `<style title=" ">${preserving("p")}</style>${featured()}`,
      ],
      [
        "an external base changing a root-relative stylesheet's origin",
        `<base href="https://cdn.example.test/"><link rel="stylesheet" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a local base without an explicit document URL",
        `<base href="/nested/"><link rel="stylesheet" href="/event-theme.css">${eventMarkup}`,
      ],
      ["a relative stylesheet URL", `<link rel="stylesheet" href="event-theme.css">${eventMarkup}`],
      [
        "a protocol-relative stylesheet URL",
        `<link rel="stylesheet" href="//cdn.example.test/event-theme.css">${eventMarkup}`,
      ],
      [
        "a dot-segment stylesheet URL",
        `<link rel="stylesheet" href="/../event-theme.css">${eventMarkup}`,
      ],
      [
        "an encoded stylesheet path",
        `<link rel="stylesheet" href="/%65vent-theme.css">${eventMarkup}`,
      ],
      [
        "a backslash stylesheet URL",
        `<link rel="stylesheet" href="/\\\\cdn.example.test/event-theme.css">${eventMarkup}`,
      ],
      [
        "an unreadable local stylesheet",
        `<link rel="stylesheet" href="/missing-oracle-control.css">${eventMarkup}`,
      ],
      [
        "a linked sheet with an unmodelled media condition",
        `<link rel="stylesheet" href="/event-theme.css" media="(width > 100px)">${eventMarkup}`,
      ],
      [
        "non-CSS source media whitespace on style",
        `<style media=" screen">${preserving("p")}</style>${featured()}`,
      ],
      [
        "non-CSS source media whitespace on link",
        `<link rel="stylesheet" href="/event-theme.css" media=" screen">${eventMarkup}`,
      ],
      [
        "an alternate relation with browser-sensitive noncanonical casing",
        `<link rel="STYLESHEET ALTERNATE" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a linked CSS type requiring MIME parsing",
        `<link rel="stylesheet" type="text/css; charset=utf-8" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a linked CSS type requiring whitespace trimming",
        `<link rel="stylesheet" type=" text/css " href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "stylesheet integrity that could reject the served bytes",
        `<link rel="stylesheet" integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" href="/event-theme.css">${eventMarkup}`,
      ],
      [
        "a meta CSP that could reject an inline stylesheet",
        `<meta http-equiv="Content-Security-Policy" content="style-src 'none'"><style>${preserving("p")}</style>${featured()}`,
      ],
      [
        "a stylesheet enabled by an unmodelled event handler",
        `<link rel="preload" as="style" href="/event-theme.css" onload="this.rel='stylesheet'">${eventMarkup}`,
      ],
      [
        "an SVG stylesheet with foreign-element semantics",
        `<svg><style>${preserving("p")}</style></svg>${featured()}`,
      ],
    ])("fails closed on %s", (_label, html) => {
      expect(() => linesIn(html)).toThrow("CSS oracle cannot evaluate");
    });

    it.each([
      ["an untitled inline sheet", `<style title="">${preserving("p")}</style>${featured()}`],
      [
        "an untitled linked sheet",
        `<link rel="stylesheet" title="" href="/event-theme.css">${eventMarkup}`,
      ],
    ])("lets %s preserve breaks", (_label, html) => {
      expect(linesIn(html)).toEqual(MULTI_LINES);
    });

    it("serves Tailwind utilities from the compiled Kit sheet, in their layer", async () => {
      const css = await compileKitGlobalCss(["whitespace-pre-line"]);
      const html = featured(`<p class="whitespace-pre-line">${MULTI}</p>`);
      expect(linesIn(html, kitGlobalExtras("", css))).toEqual(MULTI_LINES);
      const overridden = `<style>article p { white-space: normal; }</style>${html}`;
      expect(linesIn(overridden, kitGlobalExtras("", css))).toEqual(COLLAPSED);
    }, 60_000);

    it("fails closed on a variant utility it cannot evaluate", async () => {
      const css = await compileKitGlobalCss(["whitespace-pre-line", "md:whitespace-normal"]);
      const html = featured(`<p class="whitespace-pre-line md:whitespace-normal">${MULTI}</p>`);
      expect(() => linesIn(html, kitGlobalExtras("", css))).toThrow("CSS oracle cannot evaluate");
    }, 60_000);

    it.each([
      [
        "an off-site stylesheet",
        `<link rel="stylesheet" href="https://cdn.example.test/x.css">${featured()}`,
      ],
      [
        "an imported sheet",
        `<style>@import url(/theme.css); ${preserving("p")}</style>${featured()}`,
      ],
      [
        "a namespace rule",
        `<style>@namespace svg url(http://www.w3.org/2000/svg); ${preserving("p")}</style>${featured()}`,
      ],
      ["a scoped block", `<style>@scope (main) { ${preserving("p")} }</style>${featured()}`],
      [
        "a starting-style block",
        `<style>@starting-style { ${preserving("p")} }</style>${featured()}`,
      ],
      ["a nested rule", `<style>article { & p { white-space: pre-line; } }</style>${featured()}`],
      [
        "a layer declared in a conditional group",
        `<style>@media screen { @layer x { ${preserving("p")} } }</style>${featured()}`,
      ],
    ])("fails closed on %s", (_label, html) => {
      expect(() => linesIn(html)).toThrow("CSS oracle cannot evaluate");
    });
  });
});

describe("CSS oracle response CSP admission controls", () => {
  const policy = new Headers(securityHeadersFor({ path: "/events/past", method: "GET" }));
  const collapsed = ["Doors at seven Bring a deck New players welcome"];
  const rulesWithPolicy = servedRules as (
    html: string,
    extras: { css: string; source: string }[],
    headers: Headers,
  ) => CssRule[];
  const lines = (html: string) => {
    const container = smallestContaining(
      document(html),
      MULTI_LINES.filter(Boolean),
      "CSP control",
    );
    return renderedLines(container, rulesWithPolicy(html, [], policy));
  };

  it("rejects a preserving inline stylesheet under the archive policy", () => {
    expect(lines(`<style>p { white-space: pre-line }</style><p>${MULTI}</p>`)).toEqual(collapsed);
  });

  it("rejects a preserving style attribute under the archive policy", () => {
    expect(lines(`<p style="white-space: pre-line">${MULTI}</p>`)).toEqual(collapsed);
  });

  it("ignores blocked collapsing inline styles over a permitted same-origin sheet", () => {
    const markup = `<div class="event-theme"><div class="event-description"><p style="white-space: normal !important">${MULTI}</p></div></div>`;
    const html = `<link rel="stylesheet" href="/event-theme.css"><style>p { white-space: normal !important }</style>${markup}`;
    expect(lines(html)).toEqual(MULTI_LINES);
  });

  it("admits only the exact generated leaf bytes allowed by the homepage policy", () => {
    const html = renderFeaturedHono(MULTI);
    expect(html).toContain(`<style>${LEAF_CRITICAL_CSS}</style>`);
    const leafPolicy = routePolicy("/");
    const hash = createHash("sha256").update(LEAF_CRITICAL_CSS, "utf8").digest("base64");
    expect(leafPolicy.get("content-security-policy")).toContain(`'sha256-${hash}'`);
    const admitted = servedRules(html, [], leafPolicy).filter(
      (rule) => rule.source === "inline <style>",
    );
    const unrestricted = servedRules(html, [], "synthetic").filter(
      (rule) => rule.source === "inline <style>",
    );
    expect(unrestricted.length).toBeGreaterThan(0);
    expect(admitted).toEqual(unrestricted);
    const changed = html.replace(LEAF_CRITICAL_CSS, `${LEAF_CRITICAL_CSS} `);
    expect(
      servedRules(changed, [], leafPolicy).filter((rule) => rule.source === "inline <style>"),
    ).toEqual([]);
    expect(
      servedRules(html, [], policy).filter((rule) => rule.source === "inline <style>"),
    ).toEqual([]);
  });

  it("intersects multiple enforced policies instead of accepting either one", () => {
    const headers = routePolicy("/");
    headers.append("content-security-policy", "default-src 'self'; style-src 'self'");
    const html = renderFeaturedHono(MULTI);
    expect(
      servedRules(html, [], headers).filter((rule) => rule.source === "inline <style>"),
    ).toEqual([]);
  });

  it("applies a matching inline hash to rendered lines and rejects changed bytes", () => {
    const css = "p { white-space: pre-line }";
    const hash = createHash("sha256").update(css, "utf8").digest("base64");
    const headers = new Headers({
      "content-security-policy": `default-src 'self'; style-src 'self' 'sha256-${hash}'`,
    });
    const rendered = (sheet: string) => {
      const html = `<style>${sheet}</style><p>${MULTI}</p>`;
      const container = smallestContaining(
        document(html),
        MULTI_LINES.filter(Boolean),
        "hash control",
      );
      return renderedLines(container, servedRules(html, [], headers));
    };
    expect(rendered(css)).toEqual(MULTI_LINES);
    expect(rendered(`${css} `)).toEqual(collapsed);
  });

  it("does not treat a stylesheet hash as permission for style attributes", () => {
    const html = `<p style="white-space: pre-line">${MULTI}</p>`;
    const container = smallestContaining(
      document(html),
      MULTI_LINES.filter(Boolean),
      "hash control",
    );
    expect(renderedLines(container, servedRules(html, [], routePolicy("/")))).toEqual(collapsed);
  });

  it.each(["between sources", "at a directive edge"])(
    "fails closed on non-ASCII whitespace %s",
    (placement) => {
      const css = "p { white-space: pre-line }";
      const hash = createHash("sha256").update(css, "utf8").digest("base64");
      const directive = `style-src 'self' 'sha256-${hash}'`;
      const csp =
        placement === "between sources"
          ? `default-src 'self'; style-src 'self' 'sha256-${hash}'`
          : `default-src 'self'; ${directive}`;
      const html = `<style>${css}</style><p>${MULTI}</p>`;
      expect(() => servedRules(html, [], new Headers({ "content-security-policy": csp }))).toThrow(
        "CSS oracle cannot evaluate",
      );
    },
  );

  it("blocks a same-origin linked sheet when the policy excludes self", () => {
    const html = `<link rel="stylesheet" href="/event-theme.css"><div class="event-theme"><div class="event-description"><p>${MULTI}</p></div></div>`;
    const headers = new Headers({ "content-security-policy": "default-src 'none'" });
    const container = smallestContaining(
      document(html),
      MULTI_LINES.filter(Boolean),
      "link control",
    );
    expect(renderedLines(container, servedRules(html, [], headers))).toEqual(collapsed);
  });

  it.each([
    `<style nonce="fixture">p { white-space: pre-line }</style><p>${MULTI}</p>`,
    `<link rel="stylesheet" nonce="fixture" href="/event-theme.css"><p>${MULTI}</p>`,
  ])("fails closed on a nonce-bearing stylesheet", (html) => {
    expect(() => servedRules(html, [], policy)).toThrow("CSS oracle cannot evaluate");
  });

  it("does not admit external Kit extras without same-origin permission", () => {
    const html = `<p>${MULTI}</p>`;
    const headers = new Headers({ "content-security-policy": "default-src 'none'" });
    const container = smallestContaining(
      document(html),
      MULTI_LINES.filter(Boolean),
      "extra control",
    );
    const extras: CssExtra[] = [
      { css: "p { white-space: pre-line }", source: "fixture external", kind: "kit-external" },
    ];
    expect(renderedLines(container, servedRules(html, extras, headers))).toEqual(collapsed);
  });

  it.each([
    "style-src 'self' 'unsafe-inline'",
    "style-src 'self'; style-src-elem 'none'",
    "style-src 'self'; sandbox",
    "style-src 'self'; style-src 'none'",
    "style-src 'self', style-src 'nonce-example'",
  ])("fails closed for unsupported or ambiguous response policy %s", (csp) => {
    expect(() =>
      servedRules(`<p>${MULTI}</p>`, [], new Headers({ "content-security-policy": csp })),
    ).toThrow("CSS oracle cannot evaluate");
  });

  it("fails closed when response CSP is missing or an extra has no source kind", () => {
    expect(() => servedRules(`<p>${MULTI}</p>`, [], new Headers())).toThrow(
      "CSS oracle cannot evaluate",
    );
    expect(() =>
      servedRules(`<p>${MULTI}</p>`, [{ css: "p {}", source: "unknown" }], policy),
    ).toThrow("CSS oracle cannot evaluate");
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
  return { card: cards[0]!, rules: servedRules(html, [], routePolicy("/events")) };
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

/** The Kit global sheet as production serves it: web/src/app.css compiled
 * by Tailwind, with utilities for the candidates its @source globs yield
 * (as the Vite plugin scans them), plus extra candidates for controls. A
 * fresh compiler every time, because Tailwind accumulates candidates. */
async function compileKitGlobalCss(extraCandidates: string[] = []): Promise<string> {
  const webRequire = createRequire(join(root, "web/package.json"));
  type Source = { base: string; pattern: string; negated: boolean };
  const { compile } = webRequire("@tailwindcss/node") as {
    compile: (
      css: string,
      options: { base: string; onDependency: (path: string) => void },
    ) => Promise<{
      root: "none" | null | { base: string; pattern: string };
      sources: Source[];
      build: (candidates: string[]) => string;
    }>;
  };
  const { Scanner } = webRequire("@tailwindcss/oxide") as {
    Scanner: new (options: { sources: Source[] }) => { scan: () => string[] };
  };
  const base = join(root, "web/src");
  const compiler = await compile(readFileSync(join(base, "app.css"), "utf8"), {
    base,
    onDependency: () => {},
  });
  const sources: Source[] = [
    ...(compiler.root === "none"
      ? []
      : compiler.root === null
        ? [{ base, pattern: "**/*", negated: false }]
        : [{ ...compiler.root, negated: false }]),
    ...compiler.sources,
  ];
  return compiler.build([...new Scanner({ sources }).scan(), ...extraCandidates]);
}

let kitGlobalCss = "";
beforeAll(async () => {
  kitGlobalCss = await compileKitGlobalCss();
}, 60_000);

function kitGlobalExtras(extraCss = "", globalCss = kitGlobalCss): CssExtra[] {
  return [
    { css: globalCss, source: "web/src/app.css (compiled)", kind: "kit-external" },
    ...(extraCss
      ? [{ css: extraCss, source: "compiled component CSS", kind: "kit-external" as const }]
      : []),
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
        const rules = servedRules(
          html,
          twin === "Kit" ? kitGlobalExtras(kitHomeCss) : [],
          routePolicy("/"),
        );
        const needles = fixture.lines.filter(Boolean);
        const container = featuredBody(html, rules, needles);
        expectLines(container, fixture.lines, rules, `${twin} featured ${fixture.name}`, true);
        if (fixture.wrap) expectWrappable(container, rules, `${twin} featured ${fixture.name}`);
      });
    }

    it("never interprets featured text as markup and never autolinks it", () => {
      const html = twin === "Hono" ? renderFeaturedHono(HOSTILE) : renderFeaturedKit(HOSTILE);
      const rules = servedRules(
        html,
        twin === "Kit" ? kitGlobalExtras(kitHomeCss) : [],
        routePolicy("/"),
      );
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

function svelteStyleExtras(): CssExtra[] {
  // The harness omits component CSS. Model the compiled scoped CSS as
  // same-origin external output; the fixture does not verify Vite asset URLs.
  const webRequire = createRequire(join(root, "web/package.json"));
  const { compile } = webRequire("svelte/compiler") as {
    compile: (
      source: string,
      options: Record<string, unknown>,
    ) => { css?: { code: string } | null };
  };
  const files = [
    "web/src/lib/EventCard.svelte",
    "web/src/routes/events/past/+page.svelte",
    "web/src/lib/Shell.svelte",
  ];
  return files.flatMap((file) => {
    const path = join(root, file);
    const { css } = compile(readFileSync(path, "utf8"), {
      generate: "server",
      dev: false,
      filename: path,
    });
    return css?.code
      ? [
          {
            css: css.code,
            source: `${file} (compiled component CSS)`,
            kind: "kit-external" as const,
          },
        ]
      : [];
  });
}

function archivePolicy(twin: "Hono" | "Kit", response: Response): Headers {
  const headers = new Headers(response.headers);
  if (twin === "Kit") {
    // The outer Kit hook replaces the dispatch response CSP on this route.
    headers.set(
      "content-security-policy",
      routePolicy("/events/past").get("content-security-policy")!,
    );
  }
  return headers;
}

describe("archive response policy decoration", () => {
  it("replaces a pre-hook Kit CSP with the production route policy", () => {
    const response = new Response("", {
      headers: { "content-security-policy": "default-src 'none'", "x-fixture": "kept" },
    });
    const headers = archivePolicy("Kit", response);
    expect(headers.get("content-security-policy")).toBe(
      routePolicy("/events/past").get("content-security-policy"),
    );
    expect(headers.get("x-fixture")).toBe("kept");
    const html = `<link rel="stylesheet" href="/event-theme.css"><div class="event-theme"><div class="event-description"><p>${MULTI}</p></div></div>`;
    const container = smallestContaining(document(html), MULTI_LINES.filter(Boolean), "Kit policy");
    expect(renderedLines(container, servedRules(html, [], headers))).toEqual(MULTI_LINES);
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
  });

  it("keeps the actual Hono response policy", () => {
    const response = new Response("", {
      headers: { "content-security-policy": "default-src 'none'" },
    });
    expect(archivePolicy("Hono", response).get("content-security-policy")).toBe(
      "default-src 'none'",
    );
  });
});

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
      archivePolicy(twin, response),
    );
    const doc = document(html);
    const passages = elements(doc, (el) => classList(el).includes("archive-passage"));
    const passage = passages[0] ?? smallestContaining(doc, needles, `${twin} archive passage`);
    expect(passages.length, `${twin} archive passage renders for the match`).toBeLessThanOrEqual(1);
    return { passage, rules };
  }

  it("uses the archive response policy to reject inline preservation", async () => {
    const source = archiveReadFixture();
    const response = await requestArchive(twin, "/events/past?q=needle", source.env, archiveKit);
    expect(response.status).toBe(200);
    if (twin === "Hono") {
      expect(response.headers.get("content-security-policy")).toContain("style-src 'self'");
    }
    const headers = archivePolicy(twin, response);
    const html = `<style>p { white-space: pre-line }</style><p style="white-space: pre-line">${MULTI}</p>`;
    const container = smallestContaining(
      document(html),
      MULTI_LINES.filter(Boolean),
      "archive CSP",
    );
    expect(renderedLines(container, servedRules(html, [], headers))).toEqual([
      "Doors at seven Bring a deck New players welcome",
    ]);
  });

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
    const rules = servedRules(html, [], routePolicy(`/e/${EVENT_KEY}`));
    const container = smallestContaining(
      document(html),
      MULTI_LINES.filter(Boolean),
      "detail description",
    );
    expectLines(container, MULTI_LINES, rules, "CONTROL detail description");
  });
});
