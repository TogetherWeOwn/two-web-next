import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { savedEventReview } from "../src/admin/event-saved-review";
import { renderSavedEventReviewHtml } from "../src/admin/pages/event-form-review";

const page = fileURLToPath(
  new URL("../web/src/lib/EventDetail.svelte", import.meta.url).href,
);
const webRequire = createRequire(new URL("../web/package.json", import.meta.url).href);
const { compile } = webRequire("svelte/compiler");

describe("saved-event review server-only presentation", () => {
  it("escapes the shared markup before Kit injects it as trusted HTML", () => {
    const review = savedEventReview(
      {
        eventKey: 'key"><script>',
        status: "draft",
        location: "Hall",
        startsAt: new Date("2030-01-10T23:00:00Z"),
        endsAt: new Date("2030-01-11T00:00:00Z"),
      },
      new Date("2030-01-10T00:00:00Z"),
    );
    const html = renderSavedEventReviewHtml({
      ...review,
      guidance: '<img src=x onerror="alert(1)">',
      corrections: [
        {
          href: "#f-location",
          label: "<svg onload=alert(1)>",
          message: "<script>alert(1)</script>",
        },
      ],
    });
    expect(renderSavedEventReviewHtml(review, "actions")).toContain('href="/admin/events/key%22%3E%3Cscript%3E"');
    const rsvp = renderSavedEventReviewHtml(review, "rsvp");
    expect(rsvp).toContain('disabled="" aria-describedby="preview-rsvp-hint"');
    expect(rsvp).toContain('id="preview-rsvp-hint">RSVP is disabled in preview.');
    expect(rsvp).not.toContain("<form");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;svg");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<(?:script|svg|img)\b/);
  });

  it("does not duplicate the saved-review prose in the generated Kit client module", () => {
    const { js } = compile(readFileSync(page, "utf8"), {
      generate: "client",
      filename: page,
    });
    for (const prose of [
      "Preview — as members will see it",
      "Saved record last updated",
      "Fix these before publishing",
    ]) {
      expect(js.code.includes(prose), `client must not carry: ${prose}`).toBe(false);
    }
  });
});
