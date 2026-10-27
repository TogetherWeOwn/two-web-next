// route-inventory: GET /events
// route-inventory: GET /events/past
// route-inventory: GET /faq
// Independent, immutable acceptance handoff. Builder incorporates this history
// unchanged; corrections belong to the test author. No runtime source changes.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error Standalone CI helper has no declaration file (single-line import: wrapping would detach this from TS7016).
import { normalizeSection } from "../ci/kit-section-contract.mjs";
import {
  FEED_URL,
  subscriptionFixture,
  type Surface,
} from "./helpers/calendar-subscription-fixture";

// The three distinct subscribe-control renderings: kit-calendar serves the
// shared Hono calendar HTML, so hono-calendar covers it.
const TRUTH_SURFACES = ["hono-calendar", "hono-archive", "kit-archive"] as const;
type TruthSurface = (typeof TRUTH_SURFACES)[number];

// Test-only text extraction for assertions (no HTML sink): walk angle
// brackets instead of a `<...>` regex replace so the helper does not read
// as an HTML sanitizer (CodeQL incomplete sanitization).
function textOutsideTags(fragment: string, tagReplacement = "") {
  let out = "";
  let inTag = false;
  for (const ch of fragment) {
    if (ch === "<" && !inTag) {
      out += tagReplacement;
      inTag = true;
    } else if (ch === ">" && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

function decodeText(raw: string) {
  return textOutsideTags(raw, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function helpBlockOf(html: string, surface: string) {
  const blocks = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
  const hit = blocks.find((m) => m[1]!.includes("subscription-help"));
  if (!hit) throw new Error(`${surface}: subscription help block is missing`);
  return { openTag: `<details${hit[1]}>`, inner: hit[2]!, full: hit[0]! };
}

function subscribeLabel(html: string, surface: string) {
  const match = html.match(/<a\b[^>]*data-testid="events-subscribe"[^>]*>([\s\S]*?)<\/a>/);
  if (!match) throw new Error(`${surface}: subscribe link is missing`);
  return decodeText(match[1]!);
}

// The control name the guidance instructs the member to choose ("choose X,
// or add the feed URL …"). Compared against the rendered link label, never
// pinned to one wording: either side may move to the agreed label.
function instructedLabel(inner: string, surface: string) {
  const first = inner.match(/<p\b[^>]*>([\s\S]*?)<\/p>/);
  if (!first) throw new Error(`${surface}: help block has no paragraphs`);
  const text = decodeText(first[1]!);
  const match = /choose (.+?), or /.exec(text);
  if (!match) throw new Error(`${surface}: guidance instruction shape changed: ${text}`);
  return match[1]!;
}

function feedLinkOrder(html: string, surface: string) {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
  const indexOf = (pred: (attrs: string, text: string) => boolean, name: string) => {
    const hits = anchors.filter((m) => pred(m[1]!, decodeText(m[2]!)));
    if (hits.length !== 1)
      throw new Error(`${surface}: expected one ${name} link, found ${hits.length}`);
    return html.indexOf(hits[0]![0]);
  };
  const ranked: [string, number][] = [
    [
      "subscribe",
      indexOf((attrs) => attrs.includes('data-testid="events-subscribe"'), "subscribe"),
    ],
    ["download", indexOf((_, text) => text === "Download calendar (.ics)", "download")],
    ["rss", indexOf((_, text) => text === "RSS feed", "rss")],
  ];
  return ranked.sort((a, b) => a[1] - b[1]).map(([name]) => name);
}

// The static manual-copy paragraph: the non-status paragraph carrying the
// "manual" token both the current static and toast copies share.
function staticManualCopy(inner: string, surface: string) {
  const paras = [...inner.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)]
    .filter((m) => !/role="status"/.test(m[1]!))
    .map((m) => decodeText(m[2]!));
  const hits = paras.filter((text) => /manual/i.test(text));
  if (hits.length !== 1)
    throw new Error(`${surface}: expected one manual-copy paragraph, found ${hits.length}`);
  return hits[0]!;
}

function tagWith(inner: string, surface: string, pattern: RegExp, name: string) {
  const match = inner.match(pattern);
  if (!match) throw new Error(`${surface}: ${name} is missing`);
  return match[0];
}

// The shipped feed-copy toast line, read behaviorally: run the served island
// against a feed control with no Clipboard API, so the toast reports the
// manual-copy line without touching the fallback.
const binder = readFileSync(new NodeURL("../public/islands/copy-link.js", import.meta.url), "utf8");

async function toastManualCopy() {
  const toast = { textContent: "" };
  const attributes = new Map([
    ["data-copy-link", FEED_URL],
    ["data-copy-feed", ""],
  ]);
  let click: (e: { button: number; preventDefault: () => void }) => void = () => {};
  const link = {
    getAttribute: (key: string) => attributes.get(key),
    addEventListener: (kind: string, fn: typeof click) => {
      if (kind === "click") click = fn;
    },
  };
  runInNewContext(binder, {
    document: {
      querySelector: (selector: string) => (selector === "[data-copy-link]" ? link : toast),
      activeElement: null,
      createElement: () => {
        throw new Error("fallback must not run for feed controls");
      },
      body: {},
      execCommand: () => {
        throw new Error("fallback must not run for feed controls");
      },
    },
    window: { getSelection: () => null },
    navigator: {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  click({ button: 0, preventDefault: () => {} });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return toast.textContent;
}

let fixture: Awaited<ReturnType<typeof subscriptionFixture>> | undefined;
const pages = {} as Record<TruthSurface, string>;
let faqHono = "";
let faqKit = "";

beforeAll(async () => {
  fixture = await subscriptionFixture();
  for (const surface of TRUTH_SURFACES) {
    const response = await fixture.render(surface as Surface);
    expect(response.status).toBe(200);
    pages[surface] = await response.text();
  }
  faqHono = await fixture.faq("hono");
  faqKit = await fixture.faq("kit");
}, 60_000);

afterAll(() => {
  fixture?.dispose();
});

describe.each(TRUTH_SURFACES)("%s truthful subscribe controls", (surface) => {
  it("guidance names the rendered Subscribe link", () => {
    const { inner } = helpBlockOf(pages[surface], surface);
    expect(instructedLabel(inner, surface), "guidance instruction").toBe(
      subscribeLabel(pages[surface], surface),
    );
  });

  it("manual-copy toast agrees with the static help copy", async () => {
    const { inner } = helpBlockOf(pages[surface], surface);
    expect(await toastManualCopy(), "feed toast manual line").toBe(
      staticManualCopy(inner, surface),
    );
  });

  it("help block exposes testids for its controls", () => {
    const { openTag, inner } = helpBlockOf(pages[surface], surface);
    expect(openTag, "help block").toContain('data-testid="subscription-help"');
    const input = tagWith(
      inner,
      surface,
      /<input\b[^>]*id="calendar-feed-url"[^>]*>/,
      "feed URL input",
    );
    expect(input, "feed URL input").toContain('data-testid="subscription-feed-url"');
    const button = tagWith(inner, surface, /<button\b[^>]*data-copy-feed[^>]*>/, "copy button");
    expect(button, "copy button").toContain('data-testid="subscription-copy-button"');
    const manual = [...inner.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)].find(
      (m) => !/role="status"/.test(m[1]!) && /manual/i.test(decodeText(m[2]!)),
    );
    if (!manual) throw new Error(`${surface}: manual-copy paragraph is missing`);
    expect(manual[0], "manual-copy paragraph").toContain('data-testid="subscription-manual-copy"');
    const toast = tagWith(inner, surface, /<p\b[^>]*role="status"[^>]*>/, "copy toast");
    expect(toast, "copy toast").toContain('data-testid="subscription-copy-status"');
  });

  it("no-JS: feed URL input is readonly and selectable, copy button is hidden", () => {
    const { inner } = helpBlockOf(pages[surface], surface);
    const input = tagWith(
      inner,
      surface,
      /<input\b[^>]*id="calendar-feed-url"[^>]*>/,
      "feed URL input",
    );
    expect(input, "readonly input").toMatch(/\sreadonly(?=[\s>=])/);
    expect(input, "selectable feed URL").toContain(`value="${FEED_URL}"`);
    expect(input, "selectable feed URL").not.toContain("disabled");
    const button = tagWith(inner, surface, /<button\b[^>]*data-copy-feed[^>]*>/, "copy button");
    expect(button, "hidden-until-JS button").toMatch(/\shidden(?=[\s>=])/);
    expect(button, "copy target").toContain(`data-copy-link="${FEED_URL}"`);
  });
});

describe("subscribe controls cross-surface contract", () => {
  it("renders the same Subscribe label on all three surfaces", () => {
    const labels = TRUTH_SURFACES.map((surface) => subscribeLabel(pages[surface], surface));
    expect([...new Set(labels)]).toHaveLength(1);
  });

  it("orders the feed links identically on all three surfaces", () => {
    const orders = TRUTH_SURFACES.map((surface) => feedLinkOrder(pages[surface], surface));
    for (const order of orders.slice(1)) expect(order).toEqual(orders[0]);
  });

  it("keeps the help section identical across Hono and Kit targets", () => {
    const blocks = new Map(
      TRUTH_SURFACES.map((surface) => [surface, helpBlockOf(pages[surface], surface)]),
    );
    // The calendar head details is the load-bearing `subscribe` swapped zone
    // for game scoping; past surfaces carry no zone (no game facet). Pin the
    // zone per surface, then compare the zone-stripped sections byte-identical.
    expect(blocks.get("hono-calendar")!.openTag, "calendar zone").toContain(
      'data-cal-zone="subscribe"',
    );
    for (const surface of ["hono-archive", "kit-archive"] as const)
      expect(blocks.get(surface)!.openTag, `${surface} zone`).not.toContain("data-cal-zone");
    const normalized = TRUTH_SURFACES.map((surface) =>
      normalizeSection(blocks.get(surface)!.full.replace(/\sdata-cal-zone="[^"]*"/g, "")),
    );
    for (const section of normalized.slice(1)) expect(section).toBe(normalized[0]);
  });

  it.each([
    ["hono", () => faqHono],
    ["kit", () => faqKit],
  ])("%s FAQ subscribe answer names the rendered link label", (_renderer, faqOf) => {
    const text = decodeText(faqOf());
    const match = /choose (.+?), or /.exec(text);
    if (!match) throw new Error("FAQ subscribe instruction is missing");
    expect(match[1]).toBe(subscribeLabel(pages["hono-calendar"], "hono-calendar"));
  });
});
