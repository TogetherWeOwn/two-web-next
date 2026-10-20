// Implementation-owned regression pins for the two review findings on the
// terminal-review slice: the keep/unpublish guidance and the summary
// accessible name must stay inside the native review for both kinds and both
// presentations. This file reuses the acceptance fixtures read-only; it does
// not edit, disable, or rebaseline the independent acceptance suite.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TerminalReviewKind } from "../src/admin/terminal-review";
import {
  OTHER_KEY,
  SAVED_TARGET,
  SURFACES,
  actionFor,
  compileKitReview,
  kitReviewData,
  renderHonoReview,
  type Presentation,
  type Surface,
} from "./helpers/admin-terminal-review";

// Independent oracle: expected copy pinned as literals per kind, deliberately
// NOT imported from terminalReviewCopy. Deriving expectations from the copy
// under test lets emptying or rewording the source keep the suite green.
const EXPECTED_COPY: Record<
  TerminalReviewKind,
  { summary: string; keep: string; guidance: string }
> = {
  cancel: {
    summary: "Review cancellation",
    keep: "To keep the event, close this review using Review cancellation again. Your unsaved edits stay in the editor.",
    guidance: "",
  },
  delete: {
    summary: "Review deletion",
    keep: "To keep the slot, close this review using Review deletion again. Your unsaved edits stay in the editor.",
    guidance:
      "To hide the slot without deleting it, clear Published in the editor and Save instead.",
  },
};

let kit: Awaited<ReturnType<typeof compileKitReview>>;
beforeAll(async () => {
  kit = await compileKitReview();
}, 60000);
afterAll(() => kit?.close());

async function render(presentation: Presentation, surface: Surface) {
  return presentation === "hono"
    ? renderHonoReview(surface)
    : kit.render(surface, await kitReviewData(surface));
}

function kindFor(surface: Surface): TerminalReviewKind {
  return surface === "featured-edit" ? "delete" : "cancel";
}

function reviewFor(html: string, action: string) {
  const reviews = [...html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)].map((m) => m[0]);
  const matching = reviews.filter((review) => review.includes(`action="${action}"`));
  expect(matching, `one native review must contain the existing ${action} form`).toHaveLength(1);
  return matching[0]!;
}

function unescapeHtml(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function summaryLabel(review: string) {
  const summary = review.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? "";
  const raw = summary.match(/aria-label="([^"]*)"/)?.[1];
  expect(raw, "summary must carry an aria-label naming the saved target").toBeDefined();
  return unescapeHtml(raw!);
}

for (const presentation of ["hono", "kit"] as const) {
  describe(`${presentation} terminal review safeguards`, () => {
    for (const surface of SURFACES) {
      const kind = kindFor(surface);
      const copy = EXPECTED_COPY[kind];

      it(`${surface}: review keeps the exact non-destructive alternative inside the review`, async () => {
        const review = reviewFor(await render(presentation, surface), actionFor(surface));
        expect(copy.keep.length).toBeGreaterThan(0);
        expect(review).toContain(copy.keep);
        if (kind === "delete") {
          expect(copy.guidance.length).toBeGreaterThan(0);
          expect(review).toContain(copy.guidance);
        } else {
          expect(copy.guidance).toBe("");
        }
      });

      it(`${surface}: summary accessible name is the exact saved target`, async () => {
        const review = reviewFor(await render(presentation, surface), actionFor(surface));
        expect(summaryLabel(review)).toBe(`${copy.summary}: ${SAVED_TARGET}`);
      });
    }

    it("list rows carry distinct accessible names per saved event", async () => {
      const html = await render(presentation, "event-list");
      const copy = EXPECTED_COPY.cancel;
      expect(summaryLabel(reviewFor(html, actionFor("event-list")))).toBe(
        `${copy.summary}: ${SAVED_TARGET}`,
      );
      expect(summaryLabel(reviewFor(html, `/admin/events/${OTHER_KEY}/cancel`))).toBe(
        `${copy.summary}: Other saved event`,
      );
    });
  });
}
