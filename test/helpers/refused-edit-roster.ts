// Shared parser oracle for offline regressions and real-route SQL proofs.
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
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
const isInert = (node: ElementNode): boolean =>
  ["script", "style", "template"].includes(node.tagName);

// Conservative tripwires for HTML hidden and explicit inline hiding, not a
// stylesheet/cascade engine. Computed CSS and activation need Chromium proof.
const isHidden = (node: ElementNode): boolean =>
  node.attrs.some(
    (attr) =>
      attr.name === "hidden" ||
      (attr.name === "style" &&
        /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(
          attr.value,
        )),
  );

// Visible-text approximation only: inert/hidden subtrees and comments cannot
// supply assurances. Keep separators here so neighboring words stay distinct.
function visibleText(node: Node): string {
  if (isElement(node)) {
    if (isInert(node) || isHidden(node)) return " ";
    return node.childNodes.map(visibleText).join(" ");
  }
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(visibleText).join(" ") : " ";
}

export function stripTags(html: string): string {
  return normalize(visibleText(parseFragment(html)));
}

// parse5 keeps template descendants in .content, not .childNodes. Privacy
// traverses them even though visibleText deliberately excludes inert content.
function shippedChildren(node: Node): Node[] {
  if (isElement(node) && node.tagName === "template")
    return (node as DefaultTreeAdapterMap["template"]).content.childNodes;
  return "childNodes" in node ? node.childNodes : [];
}

function decodedText(node: Node, includeAttributes: boolean): string {
  const attrs =
    includeAttributes && isElement(node) ? node.attrs.map((attr) => attr.value).join("") : "";
  const own = "value" in node ? node.value : "data" in node ? node.data : "";
  return (
    attrs +
    own +
    shippedChildren(node)
      .map((child) => decodedText(child, includeAttributes))
      .join("")
  );
}

export function decodedOutput(html: string): string {
  const root = parseFragment(html);
  // No invented spaces between element-split values. Text-only and all-value
  // projections both matter: an unrelated attribute must not interrupt a name.
  // Entities decode in text/attributes, not HTML's raw script/style/comments.
  return normalize(`${decodedText(root, false)} ${decodedText(root, true)}`);
}

// Approved copy is intentionally pinned after visible-text normalization.
// A natural-language regex is not an affirmative-meaning oracle: "unsafe",
// "unhidden", punctuation and unrelated objects can reverse its assurances.
const HIDDEN_COPY = "The RSVP roster is hidden here because this save was refused.";
const UNCHANGED_COPY = "No RSVP data has changed — every response is still recorded.";
const RELOAD_COPY = "Reload the edit page to show the roster again.";
const DISCARD_COPY =
  "Reloading discards the unsaved edits currently shown, so fix the highlighted fields and save first if you want to keep them.";
const APPROVED_NOTICE = `RSVPs ${HIDDEN_COPY} ${UNCHANGED_COPY} ${RELOAD_COPY} ${DISCARD_COPY}`;
export const HIDDEN_RE = /The RSVP roster is hidden here because this save was refused\./;
export const DISCARD_RE =
  /Reloading discards the unsaved edits currently shown, so fix the highlighted fields and save first if you want to keep them\./;

// Whole-body heading tripwire is independent of notice-only counts. An
// occupied-seat field error may quote "2 members going", never "RSVPs (2)".
const ROSTER_HEADING_COUNT_RE = /RSVPs?\s*(?:\(\s*\d+\s*\)|:\s*\d+)/i;
export const NOTICE_COUNT_RE = new RegExp(
  `${ROSTER_HEADING_COUNT_RE.source}|` +
    String.raw`\b(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|both|(?:a\s+)?dozen)\s+(?:members?|attendees?|people|persons?|guests?|responses?|rsvps?|going|attending)\b`,
  "i",
);

function* rosterSections(
  node: Node,
  ancestorHidden = false,
): Generator<{ section: ElementNode; ancestorHidden: boolean }> {
  if (isElement(node)) {
    if (isInert(node)) return;
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

// Real, labelled anchors only; text in inert markup, data-href and hidden
// links/ancestors cannot supply a usable recovery control.
function* visibleAnchors(
  node: Node,
  ancestorHidden = false,
): Generator<{ href: string; index: number }> {
  if (isElement(node)) {
    if (isInert(node)) return;
    const hiddenHere = ancestorHidden || isHidden(node);
    if (
      node.tagName === "a" &&
      !hiddenHere &&
      normalize(visibleText(node)) === "Reload the edit page"
    ) {
      const href = node.attrs.find((attr) => attr.name === "href")?.value;
      if (href !== undefined) yield { href, index: node.sourceCodeLocation?.startOffset ?? -1 };
    }
    for (const child of node.childNodes) yield* visibleAnchors(child, hiddenHere);
    return;
  }
  if ("childNodes" in node)
    for (const child of node.childNodes) yield* visibleAnchors(child, ancestorHidden);
}

/** Find the canonical reload link in the parsed, visible RSVP notice section. */
export function findRosterHiddenNotice(
  html: string,
): { href: string; window: string; index: number } | null {
  const editDocumentUrl = new URL(EDIT_PATH, APP_URL);
  const root = parseFragment(html, { sourceCodeLocationInfo: true });
  for (const { section, ancestorHidden } of rosterSections(root)) {
    const location = section.sourceCodeLocation!;
    const sectionHtml = html.slice(location.startOffset, location.endOffset);
    const window = ancestorHidden ? "" : stripTags(sectionHtml);
    if (!HIDDEN_RE.test(window)) continue;
    for (const anchor of visibleAnchors(section, ancestorHidden)) {
      let url: URL;
      try {
        url = new URL(anchor.href, editDocumentUrl);
      } catch {
        continue;
      }
      // Full equality also refuses credentials, query drift and even an empty
      // '#' fragment. A same-document fragment does not perform a reload GET.
      if (url.href !== editDocumentUrl.href) continue;
      return { href: anchor.href, window, index: anchor.index };
    }
  }
  return null;
}

export function expectRefusedEditNotice(html: string) {
  const notice = findRosterHiddenNotice(html);
  expect(notice, "no roster-hidden notice link found on the 422 re-render").not.toBeNull();
  // Keep counts independent of exact copy so appended count controls exercise
  // the privacy predicate, not merely a generic wording mismatch.
  expect(notice!.window, "notice must not carry a roster count or status").not.toMatch(
    NOTICE_COUNT_RE,
  );
  const decoded = decodedOutput(html);
  expect(decoded, "refused-save body must not carry a roster heading count").not.toMatch(
    ROSTER_HEADING_COUNT_RE,
  );
  expect(notice!.window, "notice must affirm that no RSVP data changed").toContain(UNCHANGED_COPY);
  expect(notice!.window, "notice must affirm that reloading shows the roster again").toContain(
    RELOAD_COPY,
  );
  expect(notice!.window, "notice must affirm that reloading discards unsaved edits").toContain(
    DISCARD_COPY,
  );
  expect(notice!.window, "notice must retain the complete approved copy").toBe(APPROVED_NOTICE);
  // Where the roster would be: after the edit form, not buried in its errors.
  expect(notice!.index).toBeGreaterThan(html.indexOf("</form>"));
  // Identity fragments split by elements or formatting whitespace still ship.
  // Check the whole body, including inert/hidden/attribute/comment channels.
  const compact = decoded.replace(/\s+/g, "");
  for (const leaked of [...ROSTER_NAMES, ...ROSTER_IDS, ...ROSTER_ANSWERED])
    expect(compact, `refused-save body must not leak roster value ${leaked}`).not.toContain(leaked);
  expect(html).toContain('data-testid="form-errors"');
  return notice!;
}
