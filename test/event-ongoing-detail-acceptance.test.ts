// route-inventory: GET /e/:key
// Local fixtures, real Hono and compiled Svelte SSR. Run with root+web deps:
// env -u DATABASE_URL npx vitest run test/event-ongoing-detail-acceptance.test.ts
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FULL, PAUSED } from "./fixtures/schedule-availability";
import {
  END,
  MID,
  ONGOING,
  START,
  clientSurface,
  document,
  hero,
  ongoingEvent,
  visibleText,
} from "./helpers/event-ongoing-acceptance";
import { detailSnapshot } from "./helpers/event-ongoing-detail";
import { compileScheduleKit, type KitRenderer } from "./helpers/event-scheduled-range";

const TWO_LEFT = /\b2(?:\s+of\s+10)?\s+(?:seats?|spots?|places?)\s+(?:left|remaining|available)\b/i;
const PAST = /\b(?:past|ended|finished|been\s+and\s+gone)\b/i;

let kit: KitRenderer;
beforeAll(async () => {
  kit = await compileScheduleKit();
});
afterEach(() => vi.restoreAllMocks());

// Breaks caught: badge only in metadata/JSON, RSVP closure mistaken for clock
// state, missing Kit projection, and either wrong interval boundary.
const cases = [
  {
    name: "ongoing hero and seats-left coexist",
    row: ongoingEvent(),
    now: MID,
    ongoing: true,
    availability: TWO_LEFT,
  },
  {
    name: "paused ongoing hero retains RSVP pause",
    row: ongoingEvent({ rsvpOpen: false }),
    now: MID,
    ongoing: true,
    availability: PAUSED,
  },
  {
    name: "full ongoing hero retains full/waitlist truth",
    row: ongoingEvent({ goingOccupancy: 10 }),
    now: MID,
    ongoing: true,
    availability: FULL,
  },
  {
    name: "start instant is inclusive",
    row: ongoingEvent(),
    now: START,
    ongoing: true,
    availability: TWO_LEFT,
  },
  {
    name: "one millisecond before start has no badge",
    row: ongoingEvent(),
    now: new Date("2035-10-20T10:59:59.999Z"),
    ongoing: false,
    availability: TWO_LEFT,
  },
  {
    name: "last millisecond is ongoing",
    row: ongoingEvent(),
    now: new Date("2035-10-20T12:59:59.999Z"),
    ongoing: true,
    availability: TWO_LEFT,
  },
  {
    name: "end instant wins over ongoing and paused",
    row: ongoingEvent({ rsvpOpen: false }),
    now: END,
    ongoing: false,
    availability: PAST,
  },
  {
    name: "end instant wins over ongoing and full",
    row: ongoingEvent({ goingOccupancy: 10 }),
    now: END,
    ongoing: false,
    availability: PAST,
  },
  {
    name: "explicit past status has no badge inside interval",
    row: ongoingEvent({ status: "past" }),
    now: MID,
    ongoing: false,
    availability: PAST,
  },
  {
    name: "moderator draft preview has no ongoing badge",
    row: ongoingEvent({ status: "draft" }),
    now: MID,
    ongoing: false,
    availability: /\bdraft\b/i,
  },
];

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} event-detail ongoing snapshot`, () => {
    it.each(cases)("$name", async ({ row, now, ongoing, availability }) => {
      const result = await detailSnapshot(twin, row, kit, now);
      expect(result.status).toBe(200);
      const visibleHero = visibleText(hero(result.html));
      expect.soft(ONGOING.test(visibleHero), visibleHero).toBe(ongoing);
      expect.soft(visibleText(document(result.html))).toMatch(availability);
      if (now >= END) {
        expect.soft(visibleText(document(result.html))).not.toMatch(TWO_LEFT);
        expect.soft(result.html).not.toMatch(/data-testid="(?:rsvp-going|waitlist-join)"/);
      }
    });

    it("CONTROL: cancelled is gone, never ongoing, even inside its original interval", async () => {
      const result = await detailSnapshot(twin, ongoingEvent({ status: "cancelled" }), kit, MID);
      expect(result.status).toBe(410);
      const visible = visibleText(document(result.html));
      expect(visible).toMatch(/\bcancelled\b/i);
      expect(visible).not.toMatch(ONGOING);
    });

    it("CONTROL: clock changes add zero detail queries and keep private no-store", async () => {
      for (const now of [new Date("2035-10-20T10:59:59.999Z"), START, MID, END]) {
        const result = await detailSnapshot(twin, ongoingEvent(), kit, now);
        expect(result.status).toBe(200);
        // One event, two batched RSVP counts, two neighbours, related and
        // the existing member attendee/viewer/waitlist reads. No clock query.
        expect(result.queries).toHaveLength(9);
        expect(result.queries.every((sql) => /^select\b/i.test(sql))).toBe(true);
        expect(result.headers.get("cache-control")).toBe("private, no-store");
      }
    });

    it("CONTROL: an ongoing render uses only existing static islands, no fetch or new handlers", async () => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("No network allowed"));
      const result = await detailSnapshot(twin, ongoingEvent(), kit, MID);
      expect(result.status).toBe(200);
      const surface = clientSurface(result.html);
      expect(surface.scripts.map((script) => script.src).sort()).toEqual([
        "/islands/attendees-live.js",
        ...(twin === "Hono" ? ["/islands/auth-status.js"] : []),
        "/islands/copy-link.js",
        "/islands/event-device-timezone.js",
        "/islands/event-share.js",
        "/islands/event-time-from-now.js",
        "/islands/going-count.js",
        "/islands/rsvp-button.js",
      ]);
      expect(surface.scripts.every((script) => script.body === "")).toBe(true);
      expect(surface.handlers).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
}
