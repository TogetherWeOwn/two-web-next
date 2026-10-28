// Owned regression pins: deleting the draft verdict guard must expose incorrect
// availability through the actual Hono/Kit list and calendar renderers.
import { describe, expect, it } from "vitest";
import { KEY, event, model, render } from "./fixtures/schedule-availability";

const cases = [
  { name: "finite open", overrides: {}, forbidden: "2 seats left" },
  { name: "uncapped open", overrides: { capacity: null }, forbidden: "No seat limit" },
  { name: "paused", overrides: { rsvpOpen: false }, forbidden: "RSVPs paused" },
];

for (const target of ["Hono", "Kit"] as const) {
  for (const view of ["list", "calendar"] as const) {
    describe(`${target} ${view} draft availability`, () => {
      it.each(cases)(
        "keeps $name drafts without a seat verdict",
        async ({ overrides, forbidden }) => {
          const data = model([event({ ...overrides, status: "draft" })], { view });
          data.member = true;
          data.moderator = true;
          const html = await render(data, target);
          const row = html.match(
            view === "list"
              ? new RegExp(`<article\\b[^>]*id="event-${KEY}"[^>]*>[\\s\\S]*?</article>`)
              : new RegExp(`<li>\\s*<a\\b[^>]*event=${KEY}[^>]*>[\\s\\S]*?</li>`),
          )?.[0];
          expect(row, "draft remains visible to a moderator").toBeDefined();
          if (view === "list") expect(row).toContain(">Draft<");
          expect(row).not.toContain('data-testid="event-schedule-availability"');
          expect(row).not.toContain(forbidden);

          // Same path and capacity on a published row must expose the verdict;
          // an empty renderer or a hidden event cannot satisfy the negative pin.
          data.upcoming = [event(overrides)];
          expect(await render(data, target)).toContain(forbidden);
        },
      );
    });
  }
}
