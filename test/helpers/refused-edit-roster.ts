// Shared visible-text oracle for offline parser regressions and real-route SQL proofs.
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";
import { expect } from "vitest";

export const APP_URL = "https://next.example.test";
export const KEY = "01K00000000000000000000077";
export const EDIT_PATH = `/admin/events/${KEY}`;
export const FORM = {
  title: "Game night",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  capacity: "8",
  starts_at: "2026-11-04 20:00",
  ends_at: "2026-11-04 22:00",
  timezone: "Europe/London",
};
// Fixture-only roster strings: present on the GET, forbidden on any 422.
export const ROSTER_NAMES = ["RosterAdaFixture", "RosterBenFixture"] as const;
export const ROSTER_IDS = ["100000000000007701", "100000000000007702"] as const;
export const ROSTER_ANSWERED = ["2026-10-01T01:00:00.000Z", "2026-10-02T01:00:00.000Z"] as const;

type Node = DefaultTreeAdapterMap["node"];
type ElementNode = DefaultTreeAdapterMap["element"];

const isElement = (node: Node): node is ElementNode => "tagName" in node;
// The `hidden` attribute hides by presence, whatever its value.
const isHidden = (node: ElementNode): boolean => node.attrs.some((attr) => attr.name === "hidden");
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

// Visible text only: script/style subtrees, comments and every subtree
// under a `hidden` element or ancestor contribute nothing a reader sees.
function visibleText(node: Node, ancestorHidden = false): string {
  if (isElement(node)) {
    if (node.tagName === "script" || node.tagName === "style") return " ";
    if (ancestorHidden || isHidden(node)) return " ";
    return node.childNodes.map((child) => visibleText(child)).join(" ");
  }
  if ("value" in node) return ancestorHidden ? " " : node.value;
  return "childNodes" in node
    ? node.childNodes.map((child) => visibleText(child, ancestorHidden)).join(" ")
    : " ";
}

export function stripTags(html: string): string {
  return normalize(visibleText(parseFragment(html)));
}

// Every value a browser would decode from the bytes: text nodes, attribute
// values and comment data, entity-decoded by the parser. Hidden subtrees
// still ship to the client, so the privacy check does not skip them.
function decodedText(node: Node): string {
  if (isElement(node)) {
    const attrs = node.attrs.map((attr) => attr.value).join(" ");
    return [attrs, ...node.childNodes.map(decodedText)].join(" ");
  }
  if ("value" in node) return node.value;
  if (node.nodeName === "#comment") return node.data;
  return "childNodes" in node ? node.childNodes.map(decodedText).join(" ") : " ";
}

export function decodedOutput(html: string): string {
  return normalize(decodedText(parseFragment(html)));
}

// A gap may not swallow a negation: "roster is not hidden" must not pass
// the hidden pin by jumping over "not", and "will not show" must not pass
// the reload pin. Legitimate negated phrasings keep their negation inside
// the matching alternative itself ("not shown", "has not changed"), so the
// gap stops in front of them and the alternative still matches. The
// contraction arm demands its apostrophe so ordinary words such as
// "event" or "want" never read as negations.
const NO_NEG = String.raw`(?!\b(?:not|never|no|cannot|isnt|arent|wont|cant|doesnt|hasnt|havent|dont|wouldnt|couldnt|shouldnt|\w+n['’]t)\b)`;
const gap = (max: number): string => `(?:${NO_NEG}[^.]){0,${max}}`;

// The notice's four jobs, as loose semantic pins (exact copy is the
// builder's, the meaning is not):
// 1. the roster is hidden/not shown on this refused-save re-render;
export const HIDDEN_RE = new RegExp(
  String.raw`roster${gap(80)}(?:hidden|not shown|isn['’]?t shown|not displayed|not visible)|(?:hidden|not shown|not displayed)${gap(40)}roster`,
  "i",
);
// 2. no RSVP data changed;
const UNCHANGED_RE = new RegExp(
  String.raw`(?:no|none of the|nothing)${gap(60)}rsvp${gap(60)}(?:chang|delet|remov|lost)|rsvp${gap(80)}(?:unchanged|not changed|haven['’]?t changed|has not changed|still there|intact|safe)`,
  "i",
);
// 3. reloading the edit page shows the roster again;
const RELOAD_SHOWS_RE = new RegExp(
  String.raw`(?:reload|reopen|re-open)${gap(160)}(?:show|see|display|bring)${gap(80)}(?:roster|again)|roster${gap(80)}(?:again|back)${gap(80)}(?:reload|reopen)`,
  "i",
);
// 4. require an affirmative consequence, not just nearby reload/discard words.
// No arbitrary gap may swallow "does not", "never" or a different object.
export const DISCARD_RE =
  /(?:^|[.!?]\s+)(?:reload(?:ing)?|re-?open(?:ing)?|leaving)(?:\s+(?:the\s+)?edit\s+page)?\s+(?:will\s+)?(?:discards?|loses?|throws?\s+away)\s+(?:(?:the|any|your)\s+)?unsaved\s+(?:edits|changes)\b/i;

// The notice carries no roster data of any kind, including a headcount or
// a status tally. Scoped to the notice section: a refusal can legitimately
// quote an occupied-seat count in its field errors elsewhere on the page.
const NOTICE_COUNT_RE =
  /RSVPs\s*\(\d+\)|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:members?|attendees?|people|persons?|guests?|responses?|rsvps?|going|attending)\b/i;

function* rosterSections(
  node: Node,
  ancestorHidden = false,
): Generator<{ section: ElementNode; ancestorHidden: boolean }> {
  if (isElement(node)) {
    if (node.tagName === "script" || node.tagName === "style") return;
    const hiddenHere = ancestorHidden || isHidden(node);
    if (
      node.tagName === "section" &&
      node.attrs.some((attr) => attr.name === "aria-label" && attr.value === "RSVP roster")
    )
      yield { section: node, ancestorHidden };
    for (const child of node.childNodes) yield* rosterSections(child, hiddenHere);
    return;
  }
  if ("childNodes" in node)
    for (const child of node.childNodes) yield* rosterSections(child, ancestorHidden);
}

// Real parsed anchors only: markup inside comments or script/style text
// never becomes an <a> node, and only the actual `href` attribute counts.
function* visibleAnchors(
  node: Node,
  ancestorHidden = false,
): Generator<{ href: string; index: number }> {
  if (isElement(node)) {
    if (node.tagName === "script" || node.tagName === "style") return;
    const hiddenHere = ancestorHidden || isHidden(node);
    if (node.tagName === "a" && !hiddenHere) {
      const href = node.attrs.find((attr) => attr.name === "href")?.value;
      if (href !== undefined) yield { href, index: node.sourceCodeLocation?.startOffset ?? -1 };
    }
    for (const child of node.childNodes) yield* visibleAnchors(child, hiddenHere);
    return;
  }
  if ("childNodes" in node)
    for (const child of node.childNodes) yield* visibleAnchors(child, ancestorHidden);
}

/**
 * Find the canonical reload link inside the parsed RSVP notice section.
 * Words in neighboring sections cannot satisfy any of the notice's jobs.
 */
export function findRosterHiddenNotice(
  html: string,
): { href: string; window: string; index: number } | null {
  const appOrigin = new URL(APP_URL).origin;
  const root = parseFragment(html, { sourceCodeLocationInfo: true });
  for (const { section, ancestorHidden } of rosterSections(root)) {
    const location = section.sourceCodeLocation!;
    const sectionHtml = html.slice(location.startOffset, location.endOffset);
    const window = ancestorHidden ? "" : stripTags(sectionHtml);
    if (!HIDDEN_RE.test(window)) continue;
    for (const anchor of visibleAnchors(section, ancestorHidden)) {
      let url: URL;
      try {
        url = new URL(anchor.href, APP_URL);
      } catch {
        continue;
      }
      if (url.origin !== appOrigin) continue;
      if (url.pathname !== EDIT_PATH) continue;
      if ([...url.searchParams.keys()].some((k) => k.startsWith("roster_"))) continue;
      return { href: anchor.href, window, index: anchor.index };
    }
  }
  return null;
}

export function expectRefusedEditNotice(html: string) {
  const notice = findRosterHiddenNotice(html);
  expect(notice, "no roster-hidden notice link found on the 422 re-render").not.toBeNull();
  // Every job is judged only in the notice section's visible text.
  expect(notice!.window, "notice must affirm that no RSVP data changed").toMatch(UNCHANGED_RE);
  expect(notice!.window, "notice must affirm that reloading shows the roster again").toMatch(
    RELOAD_SHOWS_RE,
  );
  expect(notice!.window, "notice must affirm that reloading discards unsaved edits").toMatch(
    DISCARD_RE,
  );
  // Where the roster would be: after the edit form, not buried in the
  // error summary at the top of the form.
  expect(notice!.index).toBeGreaterThan(html.indexOf("</form>"));
  expect(notice!.window, "notice must not carry a roster count or status").not.toMatch(
    NOTICE_COUNT_RE,
  );
  // The roster itself stays out of the refused-save body. Judged on the
  // parser-decoded output, so an entity-encoded name or member id that a
  // browser would render still fails.
  const decoded = decodedOutput(html);
  for (const leaked of [...ROSTER_NAMES, ...ROSTER_IDS, ...ROSTER_ANSWERED])
    expect(decoded, `refused-save body must not leak roster value ${leaked}`).not.toContain(leaked);
  // The refusal is still a refusal: field errors remain on the page.
  expect(html).toContain('data-testid="form-errors"');
  return notice!;
}
