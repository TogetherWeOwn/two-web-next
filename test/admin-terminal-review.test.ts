// Independent acceptance: a direct terminal submit, wrong saved target, or lost
// consequence must fail these rendered-page assertions. No source-text pins.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DIRTY_TARGET,
  OTHER_KEY,
  SURFACES,
  actionFor,
  compileKitReview,
  kitReviewData,
  renderHonoReview,
  type Presentation,
  type Surface,
} from "./helpers/admin-terminal-review";

let kit: Awaited<ReturnType<typeof compileKitReview>>;
beforeAll(async () => {
  kit = await compileKitReview();
}, 60000);
afterAll(() => kit?.close());

async function render(
  presentation: Presentation,
  surface: Surface,
  status = "published",
  rejected = false,
) {
  return presentation === "hono"
    ? renderHonoReview(surface, status, rejected)
    : kit.render(surface, await kitReviewData(surface, status, rejected));
}

function reviewFor(html: string, action: string) {
  const reviews = [...html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)].map((m) => m[0]);
  const matching = reviews.filter((review) => review.includes(`action="${action}"`));
  expect(matching, `one native review must contain the existing ${action} form`).toHaveLength(1);
  return matching[0]!;
}

for (const presentation of ["hono", "kit"] as const) {
  describe(`${presentation} terminal review SSR`, () => {
    for (const surface of SURFACES) {
      it(`${surface}: positive control renders the existing endpoint and editor/list`, async () => {
        const html = await render(presentation, surface);
        expect(html).toContain("<h1");
        expect(html.match(new RegExp(`action="${actionFor(surface)}"`, "g"))).toHaveLength(1);
        expect(html).toContain(surface === "event-list" ? "Other saved event" : 'name="title"');
      });

      it(`${surface}: only a final POST inside a closed native review can mutate`, async () => {
        const review = reviewFor(await render(presentation, surface), actionFor(surface));
        expect(review.match(/^<details\b[^>]*>/)?.[0]).not.toMatch(/\sopen(?:\s|=|>)/);
        expect(review).toMatch(/<summary\b[^>]*>[\s\S]*?<\/summary>/);
        const summary = review.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? "";
        expect(summary).not.toMatch(/<form\b|<button\b[^>]*type="submit"/);
        expect(review).toMatch(/<form\b[^>]*method="post"/);
        expect(review).toMatch(/<button\b[^>]*type="submit"/);
      });

      it(`${surface}: review names the escaped saved target, not an unsaved draft`, async () => {
        const review = reviewFor(
          await render(presentation, surface, "published", surface !== "event-list"),
          actionFor(surface),
        );
        expect(review).toContain("Saved &lt;img");
        expect(review).toContain("&amp;");
        expect(review).not.toContain("<img src=x");
        expect(review).not.toContain(DIRTY_TARGET);
      });

      it(`${surface}: review explains the terminal consequence without inventing undo`, async () => {
        const review = reviewFor(await render(presentation, surface), actionFor(surface));
        if (surface === "featured-edit") {
          expect(review).toMatch(/delet|remov/i);
          expect(review).toMatch(/(?:cannot|can.t|not|no)[\s\S]{0,90}(?:undo|undone|restor)/i);
        } else {
          expect(review).toMatch(/cancel/i);
          expect(review).toMatch(
            /(?:cannot|can.t|not|no)[\s\S]{0,120}(?:restor|reopen|republish)/i,
          );
          expect(review).toMatch(/(?:cannot|can.t|not|no)[\s\S]{0,120}unpublish/i);
        }
      });
    }

    it("list reviews identify their own row rather than another event", async () => {
      const html = await render(presentation, "event-list");
      const first = reviewFor(html, actionFor("event-list"));
      const second = reviewFor(html, `/admin/events/${OTHER_KEY}/cancel`);
      expect(first).toContain("Saved &lt;img");
      expect(first).not.toContain("Other saved event");
      expect(second).toContain("Other saved event");
      expect(second).not.toContain("Saved &lt;img");
    });

    for (const status of ["draft", "published", "cancelled", "past"]) {
      it(`positive control: ${status} keeps existing cancellation eligibility`, async () => {
        for (const surface of ["event-list", "event-edit"] as const) {
          const html = await render(presentation, surface, status);
          if (status === "draft" || status === "published") {
            expect(html).toContain(`action="${actionFor(surface)}"`);
          } else {
            expect(html).not.toContain(`action="${actionFor(surface)}"`);
          }
        }
      });
    }
  });
}
