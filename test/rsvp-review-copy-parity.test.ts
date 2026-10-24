// The Kit pause review arrives as pre-rendered server HTML via load data —
// the shared renderRsvpPauseReviewHtml renderer Hono mirrors — injected via
// {@html}: inlined literals or a shared component would breach the client
// gzip and file-count ceilings. This pins that: no literal or disclosure
// markup in either page, every page injects its load-provided HTML, and both
// builders provide it from the shared renderer.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rsvpPauseReviewCopy } from "../src/admin/rsvp-review";

const pages = {
  list: readFileSync(
    fileURLToPath(new URL("../web/src/routes/admin/events/+page.svelte", import.meta.url).href),
    "utf8",
  ),
  edit: readFileSync(
    fileURLToPath(
      new URL("../web/src/routes/admin/events/[key]/+page.svelte", import.meta.url).href,
    ),
    "utf8",
  ),
};

const builders = {
  list: readFileSync(
    fileURLToPath(new URL("../src/admin/kit-events.ts", import.meta.url).href),
    "utf8",
  ),
  edit: readFileSync(
    fileURLToPath(new URL("../src/admin/kit-event-edit.ts", import.meta.url).href),
    "utf8",
  ),
};

describe("RSVP pause review copy parity", () => {
  it("list page injects its load-provided review HTML", () => {
    expect(pages.list).toContain("{@html pauseReviews[r.eventKey]");
  });
  it("edit page injects its load-provided review HTML", () => {
    expect(pages.edit).toContain("{@html view.pauseReviewHtml");
  });
  for (const [name, source] of Object.entries(pages)) {
    it(`inlines no review literal or disclosure in the ${name} page (client gzip ceiling)`, () => {
      for (const value of Object.values(rsvpPauseReviewCopy)) {
        expect(source, `${name} must not inline: ${value}`).not.toContain(value);
      }
      expect(source, `${name} must not inline the disclosure`).not.toContain("rsvp-pause-review");
    });
  }
  for (const [name, source] of Object.entries(builders)) {
    it(`provides pre-rendered review HTML from the ${name} builder`, () => {
      expect(source, `${name} builder must import the renderer`).toContain(
        "renderRsvpPauseReviewHtml",
      );
      expect(source, `${name} builder must import from rsvp-review`).toContain(
        'from "./rsvp-review"',
      );
    });
  }
});
