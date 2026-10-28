// Parser and affirmative-warning regressions run without a database.
// The five unchanged route/SQL cases run under the existing integration gate
// in admin.test.ts; run both files against a run-owned disposable database.
import { describe, expect, it } from "vitest";
import {
  APP_URL,
  EDIT_PATH,
  ROSTER_ANSWERED,
  ROSTER_IDS,
  ROSTER_NAMES,
  expectRefusedEditNotice,
  findRosterHiddenNotice,
  stripTags,
} from "./helpers/refused-edit-roster";

describe("roster notice text extraction", () => {
  it.each([
    ["uppercase script", "Before<SCRIPT>hidden</SCRIPT>After", "Before After"],
    ["mixed-case style", "Before<StYlE>hidden</sTyLe>After", "Before After"],
    ["script closing slash", "Before<script>hidden</script/>After", "Before After"],
    ["style closing attribute", "Before<style>hidden</style extra>After", "Before After"],
    ["unclosed script", "Before<script>hidden", "Before"],
    ["unclosed style", "Before<style>hidden", "Before"],
    ["hidden element", "Before<p hidden>secret</p>After", "Before After"],
    ["hidden element with a value", 'Before<p hidden="hidden">secret</p>After', "Before After"],
    ["hidden ancestor", "Before<div hidden><p>secret</p></div>After", "Before After"],
  ])("excludes %s text", (_name, html, expected) => {
    expect(stripTags(html)).toBe(expected);
  });

  it("preserves notice text and decoded entities without markup, comments or attributes", () => {
    expect(
      stripTags(
        '<p title="not > visible">Roster <strong>hidden</strong>.\nRSVPs unchanged &amp; safe.</p><!-- hidden -->' +
          "<p>Reload&#32;shows the roster. Reload discards unsaved&nbsp;edits.</p>" +
          "<p>&lt;script&gt;literal&lt;/script&gt;</p>",
      ),
    ).toBe(
      "Roster hidden . RSVPs unchanged & safe. Reload shows the roster. Reload discards unsaved edits. <script>literal</script>",
    );
  });

  // The copy and a real canonical anchor sit inside the labelled section,
  // so the case reaches the finder's visible-text branch: judging the raw
  // section HTML instead of the visible window would accept it.
  it.each(["SCRIPT", "StYlE"])("does not accept a notice supplied only by %s text", (tag) => {
    expect(
      findRosterHiddenNotice(
        '<section aria-label="RSVP roster">' +
          `<${tag}>Roster hidden. RSVPs unchanged. Reload shows the roster. Reload discards unsaved edits.</${tag}>` +
          `<a href="${EDIT_PATH}">Reload</a></section>`,
      ),
    ).toBeNull();
  });
});

describe("refused-edit discard warning oracle", () => {
  const refusedPage = (warning: string) =>
    '<form><div data-testid="form-errors">Fix the start time.</div></form>' +
    '<section aria-label="RSVP roster"><h2>RSVPs</h2><p>Roster hidden. RSVPs unchanged. ' +
    `<a href="${EDIT_PATH}">Reload the edit page</a> to show the roster again. ${warning}</p></section>`;

  it.each([
    "Reloading discards the unsaved edits currently shown.",
    "Reload will discard your unsaved changes.",
    "Reopening the edit page will discard the unsaved <strong>edits</strong> currently shown.",
  ])("accepts an affirmative consequence: %s", (warning) => {
    expect(() => expectRefusedEditNotice(refusedPage(warning))).not.toThrow();
  });

  it.each([
    "Reloading does not discard the unsaved edits currently shown.",
    "Reloading doesn't discard the unsaved edits currently shown.",
    "Reloading will not discard the unsaved edits currently shown.",
    "Reloading never discards the unsaved edits currently shown.",
    "Reloading discards no unsaved edits currently shown.",
    "Reloading discards edits but preserves your unsaved changes.",
  ])("rejects the opposite consequence: %s", (warning) => {
    expect(() => expectRefusedEditNotice(refusedPage(warning))).toThrow(
      "notice must affirm that reloading discards unsaved edits",
    );
  });

  it.each(["before", "after"])(
    "does not borrow a discard warning from a sibling section %s the notice",
    (position) => {
      const page = refusedPage("Fix the highlighted fields first.");
      const unrelated = "<section>Reloading discards the unsaved edits currently shown.</section>";
      const html = position === "before" ? unrelated + page : page + unrelated;
      expect(() => expectRefusedEditNotice(html)).toThrow(
        "notice must affirm that reloading discards unsaved edits",
      );
    },
  );

  it.each(["SCRIPT", "StYlE"])("does not count a warning inside %s", (tag) => {
    const html = refusedPage(
      `<${tag}>Reloading discards the unsaved edits currently shown.</${tag}>`,
    );
    expect(() => expectRefusedEditNotice(html)).toThrow(
      "notice must affirm that reloading discards unsaved edits",
    );
  });
});

const RELOAD_ANCHOR = `<a href="${EDIT_PATH}">Reload the edit page</a>`;
const DISCARD_WARNING = "Reloading discards the unsaved edits currently shown.";
const GOOD_NOTICE =
  `Roster hidden. RSVPs unchanged. ${RELOAD_ANCHOR} to show the roster again. ` + DISCARD_WARNING;

function noticePage(
  noticeInner: string,
  opts: {
    sectionAttrs?: string;
    wrapSection?: (section: string) => string;
    formError?: string;
    after?: string;
  } = {},
): string {
  const section =
    `<section aria-label="RSVP roster"${opts.sectionAttrs ?? ""}>` +
    `<h2>RSVPs</h2><p>${noticeInner}</p></section>`;
  return (
    `<form><div data-testid="form-errors">${opts.formError ?? "Fix the start time."}</div></form>` +
    (opts.wrapSection ? opts.wrapSection(section) : section) +
    (opts.after ?? "")
  );
}

describe("refused-edit notice affirmative assurances", () => {
  it("accepts legitimate negated phrasings for hidden and unchanged", () => {
    const notice =
      `The roster is not shown here. RSVP data has not changed. ${RELOAD_ANCHOR} ` +
      `to show the roster again. ${DISCARD_WARNING}`;
    expect(() => expectRefusedEditNotice(noticePage(notice))).not.toThrow();
  });

  it("does not read ordinary words ending in -nt as negations", () => {
    const notice =
      `The roster for this event is hidden. RSVPs unchanged. ${RELOAD_ANCHOR} ` +
      `if you want to show the roster again. ${DISCARD_WARNING}`;
    expect(() => expectRefusedEditNotice(noticePage(notice))).not.toThrow();
  });

  it("rejects the opposite hidden assurance", () => {
    const page = noticePage(GOOD_NOTICE.replace("Roster hidden.", "The roster is not hidden."));
    expect(findRosterHiddenNotice(page)).toBeNull();
    expect(() => expectRefusedEditNotice(page)).toThrow("no roster-hidden notice link found");
  });

  it.each(["RSVP data is not safe.", "RSVP data is not unchanged.", "The RSVP data isn't safe."])(
    "rejects the opposite unchanged assurance: %s",
    (unchanged) => {
      const page = noticePage(GOOD_NOTICE.replace("RSVPs unchanged.", unchanged));
      expect(() => expectRefusedEditNotice(page)).toThrow(
        "notice must affirm that no RSVP data changed",
      );
    },
  );

  it.each([
    `${RELOAD_ANCHOR} but will not show the roster again.`,
    `${RELOAD_ANCHOR} but never shows the roster again.`,
  ])("rejects the opposite reload outcome: %s", (reload) => {
    const notice = `Roster hidden. RSVPs unchanged. ${reload} ${DISCARD_WARNING}`;
    expect(() => expectRefusedEditNotice(noticePage(notice))).toThrow(
      "notice must affirm that reloading shows the roster again",
    );
  });
});

describe("refused-edit notice reload anchor oracle", () => {
  const copyWith = (anchorMarkup: string) =>
    `Roster hidden. RSVPs unchanged. ${anchorMarkup} to show the roster again. ${DISCARD_WARNING}`;

  it("accepts a real same-origin absolute edit link", () => {
    const page = noticePage(copyWith(`<a href="${APP_URL}${EDIT_PATH}">Reload the edit page</a>`));
    expect(findRosterHiddenNotice(page)?.href).toBe(`${APP_URL}${EDIT_PATH}`);
    expect(() => expectRefusedEditNotice(page)).not.toThrow();
  });

  it.each([
    ["only inside a comment", `<!-- <a href="${EDIT_PATH}">Reload the edit page</a> -->`],
    [
      "only inside a script string",
      `<script>const link = '<a href="${EDIT_PATH}">Reload the edit page</a>';</script>`,
    ],
    [
      "only as data-href on a link elsewhere",
      `<a href="/admin/events" data-href="${EDIT_PATH}">Reload the edit page</a>`,
    ],
    ["on a cross-origin absolute link", `<a href="https://evil.test${EDIT_PATH}">Reload</a>`],
    ["on a protocol-relative cross-origin link", `<a href="//evil.test${EDIT_PATH}">Reload</a>`],
  ])("rejects a canonical destination %s", (_name, anchorMarkup) => {
    expect(findRosterHiddenNotice(noticePage(copyWith(anchorMarkup)))).toBeNull();
  });
});

describe("refused-edit notice hidden content", () => {
  it("rejects a hidden notice section", () => {
    expect(findRosterHiddenNotice(noticePage(GOOD_NOTICE, { sectionAttrs: " hidden" }))).toBeNull();
  });

  it("rejects a notice section under a hidden ancestor", () => {
    const page = noticePage(GOOD_NOTICE, {
      wrapSection: (section) => `<div hidden>${section}</div>`,
    });
    expect(findRosterHiddenNotice(page)).toBeNull();
  });

  it("rejects a hidden reload link", () => {
    const notice = GOOD_NOTICE.replace("<a href=", "<a hidden href=");
    expect(findRosterHiddenNotice(noticePage(notice))).toBeNull();
  });

  it("rejects a reload link under a hidden ancestor", () => {
    const notice = GOOD_NOTICE.replace(RELOAD_ANCHOR, `<span hidden>${RELOAD_ANCHOR}</span>`);
    expect(findRosterHiddenNotice(noticePage(notice))).toBeNull();
  });

  it.each([
    ["a hidden span", `<span hidden>${DISCARD_WARNING}</span>`],
    ["a span under a hidden ancestor", `<span hidden><span>${DISCARD_WARNING}</span></span>`],
  ])("does not count a discard warning inside %s", (_name, warning) => {
    const notice = GOOD_NOTICE.replace(DISCARD_WARNING, warning);
    expect(() => expectRefusedEditNotice(noticePage(notice))).toThrow(
      "notice must affirm that reloading discards unsaved edits",
    );
  });
});

describe("refused-edit notice decoded privacy oracle", () => {
  it("rejects an entity-encoded attendee name next to a seeded member id", () => {
    const page = noticePage(GOOD_NOTICE, {
      after: `<p>&#82;${ROSTER_NAMES[0]!.slice(1)} ${ROSTER_IDS[0]}</p>`,
    });
    expect(() => expectRefusedEditNotice(page)).toThrow(
      "refused-save body must not leak roster value",
    );
  });

  it.each([
    ["an entity-encoded attendee name alone", `<p>&#82;${ROSTER_NAMES[0]!.slice(1)}</p>`],
    ["an entity-encoded member id", `<p>${ROSTER_IDS[1]!.slice(0, -1)}&#50;</p>`],
    [
      "an answered timestamp in an attribute",
      `<p><time datetime="${ROSTER_ANSWERED[0]}">answered</time></p>`,
    ],
    ["an attendee name in a hidden element", `<p hidden>${ROSTER_NAMES[1]}</p>`],
  ])("rejects %s elsewhere on the refused-save body", (_name, after) => {
    expect(() => expectRefusedEditNotice(noticePage(GOOD_NOTICE, { after }))).toThrow(
      "refused-save body must not leak roster value",
    );
  });

  it("rejects a roster count inside the notice", () => {
    const page = noticePage(`${GOOD_NOTICE} There are 2 members going.`);
    expect(() => expectRefusedEditNotice(page)).toThrow(
      "notice must not carry a roster count or status",
    );
  });

  it("allows an occupied-seat count in the field errors outside the notice", () => {
    const page = noticePage(GOOD_NOTICE, {
      formError: "Capacity is below the going count. Occupied seats: 2.",
    });
    expect(() => expectRefusedEditNotice(page)).not.toThrow();
  });
});
