// Parser and affirmative-warning regressions run without a database.
// The five unchanged route/SQL cases run under the existing integration gate
// in admin.test.ts; run both files against a run-owned disposable database.
import { describe, expect, it } from "vitest";
import {
  EDIT_PATH,
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

  it.each(["SCRIPT", "StYlE"])("does not accept a notice supplied only by %s text", (tag) => {
    expect(
      findRosterHiddenNotice(
        `<${tag}>Roster hidden. RSVPs unchanged. Reload shows the roster. Reload discards unsaved edits.</${tag}>` +
          `<a href="${EDIT_PATH}">Reload</a>`,
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
