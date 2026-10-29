// Parser regressions run without a database. The five route/SQL cases stay
// under the existing integration gate in admin.test.ts; run both on a test DB.
import { describe, expect, it } from "vitest";
import {
  APP_URL,
  EDIT_PATH,
  NOTICE_COUNT_RE,
  ROSTER_ANSWERED,
  ROSTER_IDS,
  ROSTER_NAMES,
  expectRefusedEditNotice,
  findRosterHiddenNotice,
  stripTags,
} from "./helpers/refused-edit-roster";

// Hand-pinned approved copy, independent of the oracle's expectations.
const HIDDEN_COPY = "The RSVP roster is hidden here because this save was refused.";
const UNCHANGED_COPY = "No RSVP data has changed — every response is still recorded.";
const RELOAD_ANCHOR = `<a href="${EDIT_PATH}">Reload the edit page</a>`;
const RELOAD_COPY = `${RELOAD_ANCHOR} to show the roster again.`;
const DISCARD_WARNING =
  "Reloading discards the unsaved edits currently shown, so fix the highlighted fields and save first if you want to keep them.";
const GOOD_NOTICE = `${HIDDEN_COPY} ${UNCHANGED_COPY} ${RELOAD_COPY} ${DISCARD_WARNING}`;
const CAPACITY_ERROR = "Capacity must allow the 2 members going. Choose at least 2 seats.";

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

const withWarning = (warning: string) => noticePage(GOOD_NOTICE.replace(DISCARD_WARNING, warning));

// A no-op assertion, broadened semantic regex or partial-copy match must not
// accept opposite claims, even when the other three jobs remain correct.
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
    ["template text", "Before<template><p>secret</p></template>After", "Before After"],
    ["inline display:none", 'Before<p style="display:none">secret</p>After', "Before After"],
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

  it.each(["SCRIPT", "StYlE", "template"])(
    "does not accept a notice supplied only by %s text",
    (tag) => {
      expect(
        findRosterHiddenNotice(
          `<section aria-label="RSVP roster"><${tag}>${GOOD_NOTICE}</${tag}>` +
            `<a href="${EDIT_PATH}">Reload the edit page</a></section>`,
        ),
      ).toBeNull();
    },
  );
});

describe("refused-edit discard warning oracle", () => {
  it.each([
    DISCARD_WARNING,
    DISCARD_WARNING.replace("unsaved edits", "unsaved <strong>edits</strong>"),
    DISCARD_WARNING.replace("unsaved edits", "unsaved&nbsp;edits"),
  ])("accepts the approved affirmative consequence after normalization: %s", (warning) => {
    expect(() => expectRefusedEditNotice(withWarning(warning))).not.toThrow();
  });

  it.each([
    "Reloading does not discard the unsaved edits currently shown.",
    "Reloading doesn't discard the unsaved edits currently shown.",
    "Reloading will not discard the unsaved edits currently shown.",
    "Reloading never discards the unsaved edits currently shown.",
    "Reloading discards no unsaved edits currently shown.",
    "Reloading discards edits but preserves your unsaved changes.",
  ])("rejects the opposite consequence: %s", (warning) => {
    expect(() => expectRefusedEditNotice(withWarning(warning))).toThrow(
      "notice must affirm that reloading discards unsaved edits",
    );
  });

  it.each(["before", "after"])(
    "does not borrow a discard warning from a sibling section %s the notice",
    (position) => {
      const page = withWarning("Fix the highlighted fields first.");
      const unrelated = `<section>${DISCARD_WARNING}</section>`;
      const html = position === "before" ? unrelated + page : page + unrelated;
      expect(() => expectRefusedEditNotice(html)).toThrow(
        "notice must affirm that reloading discards unsaved edits",
      );
    },
  );

  it.each(["SCRIPT", "StYlE", "template"])("does not count a warning inside %s", (tag) => {
    const html = withWarning(`<${tag}>${DISCARD_WARNING}</${tag}>`);
    expect(() => expectRefusedEditNotice(html)).toThrow(
      "notice must affirm that reloading discards unsaved edits",
    );
  });
});

describe("refused-edit notice affirmative assurances", () => {
  it("accepts the complete approved copy with whitespace and entity normalization", () => {
    const page = noticePage(
      GOOD_NOTICE.replace("RSVP roster", "RSVP\n\t roster")
        .replace("—", "&mdash;")
        .replace("unsaved edits", "unsaved&nbsp;edits"),
    );
    expect(() => expectRefusedEditNotice(page)).not.toThrow();
  });

  it("keeps ordinary -nt words in the approved consequence", () => {
    expect(GOOD_NOTICE).toContain("if you want to keep them");
    expect(() => expectRefusedEditNotice(noticePage(GOOD_NOTICE))).not.toThrow();
  });

  it.each([
    "The roster is not hidden.",
    "Roster is unhidden.",
    "Roster is shown! The seating chart stays hidden for guests",
  ])("rejects an opposite hidden assurance: %s", (hidden) => {
    const page = noticePage(GOOD_NOTICE.replace(HIDDEN_COPY, hidden));
    expect(findRosterHiddenNotice(page)).toBeNull();
    expect(() => expectRefusedEditNotice(page)).toThrow("no roster-hidden notice link found");
  });

  it.each([
    "RSVP data is not safe.",
    "RSVP data is not unchanged.",
    "The RSVP data isn't safe.",
    "RSVP data is unsafe.",
    "Another RSVP import changed the names.",
    "The noble RSVP list was changed yesterday.",
    "RSVP list reset! The backup is safe.",
    "RSVP errors are still there.",
  ])("rejects an opposite unchanged assurance: %s", (unchanged) => {
    const page = noticePage(GOOD_NOTICE.replace(UNCHANGED_COPY, unchanged));
    expect(() => expectRefusedEditNotice(page)).toThrow(
      "notice must affirm that no RSVP data changed",
    );
  });

  it.each([
    `${RELOAD_ANCHOR} but will not show the roster again.`,
    `${RELOAD_ANCHOR} but never shows the roster again.`,
    "Reload fails to show the roster again.",
    "Reload finished with unforeseen roster delays.",
    "the roster had a setback before reload completed",
    "Reload shows nothing! The roster is hidden.",
    "Reload shows none of the roster again.",
    "Reload to show the form again.",
  ])("rejects an opposite reload outcome: %s", (reload) => {
    // Keep a real canonical link even when the faulty sentence is plain text;
    // a missing anchor must not be the reason this copy control is rejected.
    const sentence = /[.!?]$/.test(reload) ? reload : `${reload}.`;
    const replacement = reload.includes("<a") ? reload : `${RELOAD_ANCHOR}. ${sentence}`;
    expect(() =>
      expectRefusedEditNotice(noticePage(GOOD_NOTICE.replace(RELOAD_COPY, replacement))),
    ).toThrow("notice must affirm that reloading shows the roster again");
  });

  it.each([
    GOOD_NOTICE.replace(HIDDEN_COPY, "The roster is not shown here."),
    GOOD_NOTICE.replace(UNCHANGED_COPY, "RSVP data has not changed."),
    GOOD_NOTICE.replace(DISCARD_WARNING, "Reload will discard your unsaved changes."),
    GOOD_NOTICE.replace(
      DISCARD_WARNING,
      "Reopening the edit page will discard the unsaved edits currently shown.",
    ),
  ])("requires approved copy rather than alternate natural-language assurances: %s", (copy) => {
    expect(() => expectRefusedEditNotice(noticePage(copy))).toThrow();
  });

  it("rejects an opposite claim appended to otherwise approved copy", () => {
    expect(() =>
      expectRefusedEditNotice(noticePage(`${GOOD_NOTICE} Actually, the RSVP data was lost.`)),
    ).toThrow("notice must retain the complete approved copy");
  });
});

describe("refused-edit notice reload anchor oracle", () => {
  const copyWith = (anchorMarkup: string) => GOOD_NOTICE.replace(RELOAD_ANCHOR, anchorMarkup);

  it.each([EDIT_PATH, `${APP_URL}${EDIT_PATH}`, EDIT_PATH.split("/").pop()!])(
    "accepts the canonical edit link: %s",
    (href) => {
      const page = noticePage(copyWith(`<a href="${href}">Reload the edit page</a>`));
      expect(findRosterHiddenNotice(page)?.href).toBe(href);
      expect(() => expectRefusedEditNotice(page)).not.toThrow();
    },
  );

  it.each([
    ["only inside a comment", `<!-- <a href="${EDIT_PATH}">Reload the edit page</a> -->`],
    [
      "only inside a script string",
      `<script>const link = '<a href="${EDIT_PATH}">Reload the edit page</a>';</script>`,
    ],
    ["only inside a style", `<style><a href="${EDIT_PATH}">Reload the edit page</a></style>`],
    ["only inside a template", `<template>${RELOAD_ANCHOR}</template>`],
    [
      "only as data-href on a link elsewhere",
      `<a href="/admin/events" data-href="${EDIT_PATH}">Reload the edit page</a>`,
    ],
    [
      "on a cross-origin absolute link",
      `<a href="https://evil.test${EDIT_PATH}">Reload the edit page</a>`,
    ],
    [
      "on a protocol-relative cross-origin link",
      `<a href="//evil.test${EDIT_PATH}">Reload the edit page</a>`,
    ],
    ["with a fragment", `<a href="${EDIT_PATH}#roster">Reload the edit page</a>`],
    ["with an empty fragment", `<a href="${EDIT_PATH}#">Reload the edit page</a>`],
    ["with only a fragment", '<a href="#roster">Reload the edit page</a>'],
    [
      "with a slashless origin-relative path",
      `<a href="${EDIT_PATH.slice(1)}">Reload the edit page</a>`,
    ],
    ["with an unrelated query", `<a href="${EDIT_PATH}?view=other">Reload the edit page</a>`],
    ["with a roster query", `<a href="${EDIT_PATH}?roster_page=2">Reload the edit page</a>`],
    [
      "with URL credentials",
      `<a href="https://guest:fixture@next.example.test${EDIT_PATH}">Reload the edit page</a>`,
    ],
  ])("rejects a canonical destination %s", (_name, anchorMarkup) => {
    expect(findRosterHiddenNotice(noticePage(copyWith(anchorMarkup)))).toBeNull();
  });
});

describe("refused-edit notice hidden content", () => {
  it.each([
    " hidden",
    ' hidden="false"',
    ' style="display:none"',
    ' style="DISPLAY: none !important"',
    ' style="visibility:collapse"',
  ])("rejects a notice section with %s", (sectionAttrs) => {
    expect(findRosterHiddenNotice(noticePage(GOOD_NOTICE, { sectionAttrs }))).toBeNull();
  });

  it.each(["hidden", 'style="display: none"', 'style="visibility:hidden"'])(
    "rejects a notice section under an ancestor with %s",
    (attrs) => {
      const page = noticePage(GOOD_NOTICE, {
        wrapSection: (section) => `<div ${attrs}>${section}</div>`,
      });
      expect(findRosterHiddenNotice(page)).toBeNull();
    },
  );

  it.each([
    "hidden",
    'style="display:none"',
    'style="visibility: hidden !important"',
    'style="visibility:collapse"',
  ])("rejects a reload link with %s", (attrs) => {
    const notice = GOOD_NOTICE.replace("<a href=", `<a ${attrs} href=`);
    expect(findRosterHiddenNotice(noticePage(notice))).toBeNull();
  });

  it.each(["hidden", 'style="display:none"', 'style="content-visibility: hidden"'])(
    "rejects a reload link under an ancestor with %s",
    (attrs) => {
      const notice = GOOD_NOTICE.replace(RELOAD_ANCHOR, `<span ${attrs}>${RELOAD_ANCHOR}</span>`);
      expect(findRosterHiddenNotice(noticePage(notice))).toBeNull();
    },
  );

  it.each([
    ["a hidden span", `<span hidden>${DISCARD_WARNING}</span>`],
    ["a span under a hidden ancestor", `<span hidden><span>${DISCARD_WARNING}</span></span>`],
    ["an inline CSS-hidden span", `<span style="display:none">${DISCARD_WARNING}</span>`],
    ["an inert template", `<template><span>${DISCARD_WARNING}</span></template>`],
  ])("does not count a discard warning inside %s", (_name, warning) => {
    expect(() => expectRefusedEditNotice(withWarning(warning))).toThrow(
      "notice must affirm that reloading discards unsaved edits",
    );
  });

  it("does not mistake ordinary inline styling for a hidden notice", () => {
    expect(() =>
      expectRefusedEditNotice(noticePage(GOOD_NOTICE, { sectionAttrs: ' style="display: block"' })),
    ).not.toThrow();
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

  it.each([ROSTER_NAMES[0], ROSTER_IDS[0], ROSTER_ANSWERED[0]])(
    "rejects individually shipped fixture value %s in every parser channel",
    (value) => {
      const at = Math.floor(value.length / 2);
      const entity = `&#${value.charCodeAt(0)};${value.slice(1)}`;
      const channels = [
        `<b>${value.slice(0, at)}</b>${value.slice(at)}`,
        `<b title="unrelated">${value.slice(0, at)}</b>${value.slice(at)}`,
        `<span>${entity.slice(0, entity.indexOf(";") + 1)}</span>${value.slice(1)}`,
        `<template><p>${entity}</p></template>`,
        `<template><template><p data-value="${entity}">inert</p></template></template>`,
        `<template data-value="${entity}"></template>`,
        `<p hidden>${value}</p>`,
        `<p style="display:none">${entity}</p>`,
        `<script>const fixture = "${value}";</script>`,
        `<style>/* ${value} */</style>`,
        `<!-- ${value} -->`,
        `<p data-value="${entity}">attribute only</p>`,
      ];
      for (const after of channels) {
        expect(() => expectRefusedEditNotice(noticePage(GOOD_NOTICE, { after })), after).toThrow(
          "refused-save body must not leak roster value",
        );
      }
    },
  );

  it.each([...ROSTER_NAMES, ...ROSTER_IDS, ...ROSTER_ANSWERED])(
    "rejects split roster value %s when the suffix element has an unrelated attribute",
    (value) => {
      const at = Math.floor(value.length / 2);
      // The suffix attribute interrupts the all-values stream; the independent
      // text-only projection must still reject the complete shipped value.
      const after = `<b>${value.slice(0, at)}</b><span title="unrelated">${value.slice(at)}</span>`;
      expect(() => expectRefusedEditNotice(noticePage(GOOD_NOTICE, { after }))).toThrow(
        `refused-save body must not leak roster value ${value}`,
      );
    },
  );

  it("rejects the reported Roster/AdaFixture split without a neighboring id", () => {
    const page = noticePage(GOOD_NOTICE, { after: "<b>Roster</b>AdaFixture" });
    expect(() => expectRefusedEditNotice(page)).toThrow(
      "refused-save body must not leak roster value",
    );
  });

  it("does not count inert template text as a visible assurance", () => {
    const template = `<template><p>${GOOD_NOTICE}</p><span data-user="${ROSTER_NAMES[0]}">inert</span></template>`;
    expect(stripTags(template)).toBe("");
    expect(findRosterHiddenNotice(template)).toBeNull();
    expect(() => expectRefusedEditNotice(noticePage(GOOD_NOTICE, { after: template }))).toThrow(
      "refused-save body must not leak roster value",
    );
  });
});

describe("refused-edit count scoping", () => {
  it.each([
    "There are 2 members going.",
    "RSVP (3)",
    "RSVP: 3",
    "There are thirteen members going.",
    "Zero members going so far.",
    "Both members going still.",
    "A dozen members going.",
  ])("rejects a count inside an otherwise approved notice: %s", (count) => {
    expect(() => expectRefusedEditNotice(noticePage(`${GOOD_NOTICE} ${count}`))).toThrow(
      "notice must not carry a roster count or status",
    );
  });

  it.each(["RSVPs (2)", "RSVP (3)", "RSVP: 3"])(
    "rejects a stray roster heading outside a clean notice: %s",
    (heading) => {
      expect(() =>
        expectRefusedEditNotice(noticePage(GOOD_NOTICE, { after: `<h2>${heading}</h2>` })),
      ).toThrow("refused-save body must not carry a roster heading count");
    },
  );

  it("rejects the capacity-count predicate inside the notice", () => {
    expect(() => expectRefusedEditNotice(noticePage(`${GOOD_NOTICE} ${CAPACITY_ERROR}`))).toThrow(
      "notice must not carry a roster count or status",
    );
  });

  it("allows an occupied-seat count in the field errors outside the notice", () => {
    // This must match the very predicate the helper scopes to the notice.
    // The paired inside-notice control and the whole-page-scope mutation
    // ensure an ineffective fixture cannot make this allowance look covered.
    expect(CAPACITY_ERROR).toMatch(NOTICE_COUNT_RE);
    expect(stripTags(noticePage(GOOD_NOTICE))).not.toMatch(NOTICE_COUNT_RE);
    const page = noticePage(GOOD_NOTICE, { formError: CAPACITY_ERROR });
    expect(() => expectRefusedEditNotice(page)).not.toThrow();
  });
});
