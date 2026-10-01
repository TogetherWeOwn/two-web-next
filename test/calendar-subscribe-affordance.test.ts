import { describe, expect, it } from "vitest";
import { EventPage, EventsCalendarPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";

const start = new Date("2026-10-10T20:00:00Z");
const event: PublicEvent = {
  id: 1, eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV", title: "Chess & <friends>", game: "Chess",
  description: "Bring a board & <snacks>.", location: "Lobby & lounge",
  startsAt: start, endsAt: new Date("2026-10-10T22:00:00Z"), timezone: "UTC",
  capacity: 10, status: "published", rsvpOpen: true, goingCount: 3, icsSequence: 1n,
  discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
  createdBy: null, recurrenceFrequency: null, recurrenceCount: null,
  recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null, createdAt: start, updatedAt: start,
};

describe("calendar subscription affordance SSR", () => {
  for (const appUrl of ["https://calendar.example.test", "https://calendar.example.test/"]) {
    for (const view of ["list", "calendar"] as const) {
      it(`renders native subscribe and HTTPS download links for ${view} at ${appUrl}`, async () => {
        const html = await EventsCalendarPage({
          state: { view, month: "2026-10", q: "", past: false },
          upcoming: [event],
          past: [],
          zone: "UTC",
          now: new Date("2026-10-01T12:00:00Z"),
          emptyState: null,
          discordFailed: false,
          member: false,
          inviteUrl: "https://discord.gg/example",
          appUrl,
        })!.toString();

        const subscribe = html.match(/<a\b[^>]*data-testid="events-subscribe"[^>]*>[^<]*<\/a>/g);
        expect(subscribe).toEqual([
          '<a href="webcal://calendar.example.test/events.ics" data-testid="events-subscribe">Subscribe</a>',
        ]);
        expect(html).toContain('<a href="https://calendar.example.test/events.ics">Download calendar (.ics)</a>');
        expect(subscribe![0]).not.toMatch(/\son\w+=|\bdata-cal-jump\b/);
        expect(html).toContain('<a href="/events/past" data-testid="events-past-archive-link">Past events</a>');
        if (view === "list") {
          expect(html).toContain(`<a href="/e/${event.eventKey}">Chess &amp; &lt;friends&gt;</a>`);
          expect(html).toContain("Bring a board &amp; &lt;snacks&gt;.");
        }
      });
    }

    it(`preserves the per-event ICS and Google Calendar links at ${appUrl}`, async () => {
      const html = await EventPage({
        e: event, neighbors: { previous: null, next: null }, related: [], appUrl, jsonLd: "{}",
      })!.toString();
      expect(html).toContain(`<a href="/events/${event.eventKey}.ics" data-testid="event-ics">Add to calendar (.ics)</a>`);
      expect(html).toContain(
        'href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Chess%20%26%20%3Cfriends%3E&amp;dates=20261010T200000Z%2F20261010T220000Z&amp;details=Bring%20a%20board%20%26%20%3Csnacks%3E.&amp;location=Lobby%20%26%20lounge" data-testid="event-google-calendar" rel="noopener">Google Calendar</a>',
      );
      expect(html).toContain("Chess &amp; &lt;friends&gt;");
      expect(html).toContain("Bring a board &amp; &lt;snacks&gt;.");
      expect(html).not.toMatch(/\son(?:click|keydown)=/);
    });
  }
});
