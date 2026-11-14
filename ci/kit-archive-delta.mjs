// Archive-only presentation delta between Kit (Ember) and Hono (legacy).
//
// The Kit row adds a decorative glyph and a "Sign-up record" label in an
// `event-title` wrapper around the legacy <h2>; Hono has none. The raw Kit
// section is parsed (source locations on, nothing normalized first); each
// wrapper must be li[data-testid=event-card] > div.schedule-info > div.event-title
// holding only glyph (SVG namespace, one circle), <h2>, label, and each cut's
// raw source must match the exact shipped bytes. Only the wrapper tags, glyph
// and label ranges are cut; all other bytes stay for the strict Hono compare.
// Anything delta-like outside that, or partial Ember, throws.
import { parseFragment } from "parse5";

const SVG = "http://www.w3.org/2000/svg";
const HTML = "http://www.w3.org/1999/xhtml";
const HASH = "(?: svelte-[a-z0-9]+)?";
const fail = (why) => {
  throw new Error(`Ember archive delta rejected: ${why}`);
};
const isEl = (n) => typeof n.tagName === "string";
const blank = (n) => n.nodeName === "#text" && n.value.trim() === "";
const is = (el, tag, ns) => isEl(el) && el.tagName === tag && el.namespaceURI === ns;
const classTokens = (el) =>
  (isEl(el) ? (el.attrs.find((a) => a.name === "class")?.value ?? "") : "").split(/\s+/);
const flagged = (el) =>
  isEl(el) &&
  (["svg", "circle"].includes(el.tagName) ||
    classTokens(el).some((t) => ["state-glyph", "event-title", "event-state"].includes(t)));

const isCard = (n) =>
  n?.tagName === "li" && n.attrs.some((a) => a.name === "data-testid" && a.value === "event-card");

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}

const range = (n) => [n.sourceCodeLocation.startOffset, n.sourceCodeLocation.endOffset];
const tagRange = (n) => [
  n.sourceCodeLocation.startTag.startOffset,
  n.sourceCodeLocation.startTag.endOffset,
];

function validate(wrapper, raw) {
  const row = wrapper.parentNode;
  const info = row && isEl(row) ? row : fail("wrapper has no parent");
  const li = info.parentNode;
  if (!is(info, "div", HTML) || !isCard(li)) fail("wrapper is not directly in an event-card row");
  if (info.childNodes.find((n) => !blank(n)) !== wrapper) fail("wrapper is not first");
  if (!is(wrapper, "div", HTML)) fail("wrapper tag");
  const kids = wrapper.childNodes.filter((n) => !blank(n));
  if (kids.length !== 3) fail("wrapper children");
  const [glyph, heading, label] = kids;
  if (!is(glyph, "svg", SVG)) fail("glyph");
  const inner = glyph.childNodes.filter(
    (n) => !blank(n) && !(n.nodeName === "#comment" && /^(?:\[[\d-]*|\])$/.test(n.data)),
  );
  if (inner.length !== 1 || !is(inner[0], "circle", SVG) || inner[0].childNodes.length) {
    fail("glyph children");
  }
  const text = label.childNodes ?? [];
  if (!is(heading, "h2", HTML) || !is(label, "span", HTML) || text.length !== 1)
    fail("heading or label");
  // parse5 canonicalizes (duplicate attributes dropped, entities decoded,
  // omitted end tags synthesized), so the raw source of every cut must also
  // match the exact shipped bytes; only the Svelte scope class and hydration
  // marker comments are tolerated.
  const { startTag, endTag } = wrapper.sourceCodeLocation ?? {};
  if (!startTag || !endTag) fail("wrapper source range");
  const gap = "(?:\\s|<!--\\[[\\d-]*-->|<!--\\]-->)*";
  const exact = [
    [raw.slice(startTag.startOffset, startTag.endOffset), `<div class="event-title${HASH}">`],
    [raw.slice(endTag.startOffset, endTag.endOffset), "</div>"],
    [
      raw.slice(...range(glyph)),
      `<svg class="state-glyph${HASH}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">` +
        `${gap}<circle cx="8" cy="8" r="8" fill="currentColor"></circle>${gap}</svg>`,
    ],
    [raw.slice(...range(label)), `<span class="event-state${HASH}">Sign-up record</span>`],
    [raw.slice(...range(heading)).slice(0, 4), "<h2>"],
    [raw.slice(...tagRange(info)), '<div class="schedule-info">'],
  ];
  for (const [source, pattern] of exact) {
    if (!new RegExp(`^${pattern}$`).test(source)) fail("raw markup is not the exact shipped bytes");
  }
  if (!heading.sourceCodeLocation.endTag || !label.sourceCodeLocation.endTag)
    fail("implied end tag");
  return {
    claimed: [wrapper, glyph, inner[0], label],
    cuts: [
      [startTag.startOffset, startTag.endOffset],
      range(glyph),
      range(label),
      [endTag.startOffset, endTag.endOffset],
    ],
  };
}

function strip(raw) {
  const root = parseFragment(raw, { sourceCodeLocationInfo: true });
  const all = [];
  walk(root, (n) => isEl(n) && all.push(n));
  const cards = all.filter(isCard).length;
  const claimed = new Set();
  const decoratedCards = new Set();
  const cuts = [];
  const wrappers = all.filter((n) => classTokens(n).includes("event-title"));
  for (const wrapper of wrappers) {
    const found = validate(wrapper, raw);
    const card = wrapper.parentNode.parentNode;
    if (decoratedCards.has(card)) fail("multiple wrappers on one card");
    decoratedCards.add(card);
    for (const node of found.claimed) claimed.add(node);
    cuts.push(...found.cuts);
  }
  if (all.some((n) => flagged(n) && !claimed.has(n)))
    fail("delta-like node outside the exact topology");
  if (wrappers.length !== 0 && wrappers.length !== cards) {
    fail(`Ember delta on ${wrappers.length} of ${cards} cards`);
  }
  let html = raw;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0]))
    html = html.slice(0, start) + html.slice(end);
  return { html, cards, ember: wrappers.length };
}

export function stripEmberDelta(raw) {
  return strip(raw).html;
}

// Independent feature assertion: every card carries the glyph and the label.
export function assertEmberArchive(raw) {
  const { cards, ember } = strip(raw);
  if (cards === 0 || ember !== cards) {
    throw new Error(`Ember archive delta rejected: glyph and label on ${ember}/${cards} cards`);
  }
}
