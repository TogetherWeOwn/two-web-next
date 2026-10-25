// Independent acceptance: pausing RSVPs requires a native server-rendered
// review on both renderers; reopen stays one-click. No source-text pins.
//
// Contract (mirrors the terminal-action review pattern, pause-only):
// - The pause POST lives inside exactly one initially-closed <details> review.
//   Opening/abandoning the review makes no mutation request; only the clearly
//   labelled final submit uses the existing POST endpoint (unchanged URL,
//   auth, throttle, and failure semantics).
// - The review names the escaped saved target (never a dirty draft) and states
//   the truthful consequence: signups close and the waitlist line freezes.
// - Reopen keeps its current direct one-click POST (no review wrapper).
// - This is accident-prevention UI, not a server-enforced gate: no token,
//   nonce, route, or backend confirmation state is asserted here.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ATTRIBUTE_BREAKOUT_TARGET,
  DIRTY_TARGET,
  OTHER_KEY,
  SAVED_TARGET,
  SURFACES,
  compileKitPauseReview,
  kitReviewData,
  pauseActionFor,
  renderHonoReview,
  reopenActionFor,
  type Presentation,
  type Surface,
} from "./helpers/admin-rsvp-pause-review";

let kit: Awaited<ReturnType<typeof compileKitPauseReview>>;
beforeAll(async () => {
  kit = await compileKitPauseReview();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
}, 60000);
afterAll(() => {
  vi.useRealTimers();
  kit?.close();
});

async function render(
  presentation: Presentation,
  surface: Surface,
  opts: {
    rsvpOpen?: boolean;
    status?: string;
    rejectedSave?: boolean;
    title?: string;
    endsAt?: Date;
  } = {},
) {
  const open = opts.rsvpOpen ?? true;
  const status = opts.status ?? "published";
  const rejected = opts.rejectedSave ?? false;
  const title = opts.title ?? SAVED_TARGET;
  const options = { rsvpOpen: open, status, rejectedSave: rejected, title, endsAt: opts.endsAt };
  return presentation === "hono"
    ? renderHonoReview(surface, options)
    : kit.render(surface, await kitReviewData(surface, options));
}

function reviewFor(html: string, action: string) {
  const reviews = [...html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)].map((m) => m[0]);
  const matching = reviews.filter((review) => review.includes(`action="${action}"`));
  expect(matching, `one native review must contain the existing ${action} form`).toHaveLength(1);
  return matching[0]!;
}

function summaryLabel(review: string) {
  const label = review.match(/<summary\b[^>]*\baria-label="([^"]*)"/)?.[1];
  expect(label, "review summary must have an aria-label").toBeDefined();
  return label!
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function formsFor(html: string, action: string) {
  return [...html.matchAll(new RegExp(`<form\\b[^>]*action="${action}"[^>]*>`, "g"))].map(
    (m) => m[0],
  );
}

for (const presentation of ["hono", "kit"] as const) {
  describe(`${presentation} RSVP pause review SSR`, () => {
    for (const surface of SURFACES) {
      it(`${surface}: positive control renders the existing pause endpoint and editor/list`, async () => {
        const html = await render(presentation, surface);
        expect(html).toContain("<h1");
        expect(formsFor(html, pauseActionFor(surface))).toHaveLength(1);
        expect(html).toContain(surface === "event-list" ? "Other saved event" : 'name="title"');
      });

      it(`${surface}: only a final POST inside a closed native review can pause`, async () => {
        const review = reviewFor(await render(presentation, surface), pauseActionFor(surface));
        expect(review.match(/^<details\b[^>]*>/)?.[0]).not.toMatch(/\sopen(?:\s|=|>)/);
        expect(review).toMatch(/<summary\b[^>]*>[\s\S]*?<\/summary>/);
        const summary = review.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? "";
        expect(summary).not.toMatch(/<form\b|<button\b[^>]*type="submit"/);
        expect(summary).toMatch(/review|pause/i);
        expect(review).toMatch(/<form\b[^>]*method="post"/);
        expect(review).toMatch(/<button\b[^>]*type="submit"/);
        const final =
          review.match(/<button\b[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
        expect(final).toMatch(/pause|confirm/i);
      });

      it(`${surface}: review names the escaped saved target, not an unsaved draft`, async () => {
        const review = reviewFor(
          await render(presentation, surface, {
            rejectedSave: surface !== "event-list",
          }),
          pauseActionFor(surface),
        );
        expect(review).toContain("Saved &lt;img");
        expect(review).toContain("&amp;");
        expect(review).not.toContain("<img src=x");
        expect(review).not.toContain(DIRTY_TARGET);
        expect(summaryLabel(review)).toBe(`Review pause: ${SAVED_TARGET}`);
      });

      it(`${surface}: quoted attribute-breakout title keeps the complete review label`, async () => {
        const review = reviewFor(
          await render(presentation, surface, { title: ATTRIBUTE_BREAKOUT_TARGET }),
          pauseActionFor(surface),
        );
        expect(summaryLabel(review)).toBe(`Review pause: ${ATTRIBUTE_BREAKOUT_TARGET}`);
      });

      it(`${surface}: review states signups close and the line freezes`, async () => {
        const review = reviewFor(await render(presentation, surface), pauseActionFor(surface));
        expect(review).toMatch(
          /sign[- ]?ups? close|close.*sign[- ]?ups?|rsvps? (are |will be )?paused|pause.*rsvp/i,
        );
        expect(review).toMatch(
          /freez|frozen|waitlist.*(freez|frozen|hold)|line.*(freez|frozen|hold)/i,
        );
      });

      it(`${surface}: reopen stays a direct one-click POST with no review wrapper`, async () => {
        const html = await render(presentation, surface, { rsvpOpen: false });
        expect(formsFor(html, reopenActionFor(surface))).toHaveLength(1);
        expect(html).not.toContain(pauseActionFor(surface));
        const reviews = [...html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)].map((m) => m[0]);
        const wrapping = reviews.filter((review) =>
          review.includes(`action="${reopenActionFor(surface)}"`),
        );
        expect(wrapping, "reopen must not be wrapped in a review").toHaveLength(0);
      });

      it(`${surface}: review keeps a single pause form with no nested forms`, async () => {
        const html = await render(presentation, surface);
        expect(formsFor(html, pauseActionFor(surface))).toHaveLength(1);
        const pauseForm = html.match(
          new RegExp(`<form\\b[^>]*action="${pauseActionFor(surface)}"[^>]*>[\\s\\S]*?</form>`),
        )?.[0];
        expect(pauseForm, "pause form element must render").toBeDefined();
        expect(pauseForm!.match(/<form\b/g)).toHaveLength(1);
      });
    }

    it("list reviews identify their own row rather than another event", async () => {
      const html = await render("hono" === presentation ? "hono" : "kit", "event-list");
      const first = reviewFor(html, pauseActionFor("event-list"));
      const second = reviewFor(html, `/admin/events/${OTHER_KEY}/rsvp-pause`);
      expect(first).toContain("Saved &lt;img");
      expect(first).not.toContain("Other saved event");
      expect(second).toContain("Other saved event");
      expect(second).not.toContain("Saved &lt;img");
    });

    for (const status of ["draft", "published", "cancelled", "past"]) {
      it(`positive control: ${status} keeps existing pause/reopen eligibility`, async () => {
        for (const surface of ["event-list", "event-edit"] as const) {
          const html = await render(presentation, surface, { status });
          if (status === "published") {
            expect(html).toContain(`action="${pauseActionFor(surface)}"`);
            expect(html).not.toContain(`action="${reopenActionFor(surface)}"`);
          } else {
            expect(html).not.toContain(`action="${pauseActionFor(surface)}"`);
            expect(html).not.toContain(`action="${reopenActionFor(surface)}"`);
          }
        }
      });
    }

    for (const endsAt of ["2030-01-01T11:59:59.999Z", "2030-01-01T12:00:00Z"]) {
      for (const rsvpOpen of [true, false]) {
        it(`published endsAt=${endsAt} rsvpOpen=${rsvpOpen}: neither surface offers pause or reopen`, async () => {
          for (const surface of SURFACES) {
            const html = await render(presentation, surface, {
              status: "published",
              rsvpOpen,
              endsAt: new Date(endsAt),
            });
            expect(html).not.toContain(`action="${pauseActionFor(surface)}"`);
            expect(html).not.toContain(`action="${reopenActionFor(surface)}"`);
          }
        });
      }
    }

    it("positive control: paused rows offer reopen on both surfaces", async () => {
      for (const surface of ["event-list", "event-edit"] as const) {
        const html = await render(presentation, surface, { rsvpOpen: false });
        expect(html).toContain(`action="${reopenActionFor(surface)}"`);
        expect(html).not.toContain(`action="${pauseActionFor(surface)}"`);
      }
    });
  });
}
