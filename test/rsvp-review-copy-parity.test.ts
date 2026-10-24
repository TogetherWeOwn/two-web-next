// The Kit pause review is inlined in both admin pages (a shared component
// would breach the client file-count ceiling), so its copy is literal in
// each page. This pins every shared string from src/admin/rsvp-review.ts to
// appear verbatim in both pages, failing on drift in either direction.
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

describe("RSVP pause review copy parity", () => {
  for (const [name, source] of Object.entries(pages)) {
    it(`inlines every shared string in the ${name} page`, () => {
      for (const value of Object.values(rsvpPauseReviewCopy)) {
        expect(source, `${name} must inline: ${value}`).toContain(value);
      }
    });
  }
});
