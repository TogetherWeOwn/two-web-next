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
export const ROSTER_ANSWERED = ["2026-10-01T01:00:00.000Z", "2026-10-02T01:00:00.000Z"] as const;

export function stripTags(html: string): string {
  const text = (node: DefaultTreeAdapterMap["node"]): string => {
    if ("tagName" in node && (node.tagName === "script" || node.tagName === "style")) return " ";
    if ("value" in node) return node.value;
    return "childNodes" in node ? node.childNodes.map(text).join(" ") : " ";
  };
  return text(parseFragment(html)).replace(/\s+/g, " ").trim();
}

// The notice's four jobs, as loose semantic pins (exact copy is the
// builder's, the meaning is not):
// 1. the roster is hidden/not shown on this refused-save re-render;
export const HIDDEN_RE =
  /roster[^.]{0,80}(hidden|not shown|isn'?t shown|not displayed|not visible)|(hidden|not shown|not displayed)[^.]{0,40}roster/i;
// 2. no RSVP data changed;
const UNCHANGED_RE =
  /(no|none of the|nothing)[^.]{0,60}rsvp[^.]{0,60}(chang|delet|remov|lost)|rsvp[^.]{0,80}(unchanged|not changed|haven'?t changed|has not changed|still there|intact|safe)/i;
// 3. reloading the edit page shows the roster again;
const RELOAD_SHOWS_RE =
  /(reload|reopen|re-open)[^.]{0,160}(show|see|display|bring)[^.]{0,80}(roster|again)|roster[^.]{0,80}(again|back)[^.]{0,80}(reload|reopen)/i;
// 4. require an affirmative consequence, not just nearby reload/discard words.
// No arbitrary gap may swallow "does not", "never" or a different object.
export const DISCARD_RE =
  /(?:^|[.!?]\s+)(?:reload(?:ing)?|re-?open(?:ing)?|leaving)(?:\s+(?:the\s+)?edit\s+page)?\s+(?:will\s+)?(?:discards?|loses?|throws?\s+away)\s+(?:(?:the|any|your)\s+)?unsaved\s+(?:edits|changes)\b/i;

type Anchor = { href: string; index: number };
const anchors = (html: string): Anchor[] =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>/g)].map((m) => ({
    href: m[1]!.replaceAll("&amp;", "&"),
    index: m.index,
  }));

/**
 * Find the canonical reload link inside the parsed RSVP notice section.
 * Words in neighboring sections cannot satisfy any of the notice's jobs.
 */
export function findRosterHiddenNotice(
  html: string,
): { href: string; window: string; index: number } | null {
  function* sections(
    node: DefaultTreeAdapterMap["node"],
  ): Generator<DefaultTreeAdapterMap["element"]> {
    if (
      "tagName" in node &&
      node.tagName === "section" &&
      node.attrs.some((attr) => attr.name === "aria-label" && attr.value === "RSVP roster")
    )
      yield node;
    if ("childNodes" in node) for (const child of node.childNodes) yield* sections(child);
  }
  for (const section of sections(parseFragment(html, { sourceCodeLocationInfo: true }))) {
    const location = section.sourceCodeLocation!;
    const sectionHtml = html.slice(location.startOffset, location.endOffset);
    const window = stripTags(sectionHtml);
    if (!HIDDEN_RE.test(window)) continue;
    for (const anchor of anchors(sectionHtml)) {
      const url = new URL(anchor.href, APP_URL);
      if (url.pathname !== EDIT_PATH) continue;
      if ([...url.searchParams.keys()].some((k) => k.startsWith("roster_"))) continue;
      return { href: anchor.href, window, index: location.startOffset + anchor.index };
    }
  }
  return null;
}

export function expectRefusedEditNotice(html: string) {
  const notice = findRosterHiddenNotice(html);
  expect(notice, "no roster-hidden notice link found on the 422 re-render").not.toBeNull();
  // Every job is judged only in the notice section's visible text.
  expect(notice!.window).toMatch(UNCHANGED_RE);
  expect(notice!.window).toMatch(RELOAD_SHOWS_RE);
  expect(notice!.window, "notice must affirm that reloading discards unsaved edits").toMatch(
    DISCARD_RE,
  );
  // Where the roster would be: after the edit form, not buried in the
  // error summary at the top of the form.
  expect(notice!.index).toBeGreaterThan(html.indexOf("</form>"));
  // The roster itself stays out of the refused-save body, including any
  // roster-derived count (the GET renders it as "RSVPs (2)").
  for (const leaked of [...ROSTER_NAMES, ...ROSTER_ANSWERED]) expect(html).not.toContain(leaked);
  expect(html).not.toMatch(/RSVPs \(\d+\)/);
  // The refusal is still a refusal: field errors remain on the page.
  expect(html).toContain('data-testid="form-errors"');
  return notice!;
}
