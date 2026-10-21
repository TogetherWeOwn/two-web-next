// Implementation-owned pins for the event device-timezone enhancement.
// The independent acceptance contract lives in
// test/event-device-timezone.test.ts (Test Author owned, never edited here);
// these cases pin the served-markup guards the acceptance suite does not:
// the hidden-until-JS action and the empty fresh-render result region.
import { describe, expect, it } from "vitest";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";

const APP_URL = "https://next.example.test";

function eventFixture(): PublicEvent {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "Voice lobby",
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    goingCount: 2,
    goingOccupancy: 2,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    syncRevision: 1,
    syncedRevision: 0,
    createdAt: start,
    updatedAt: start,
  };
}

describe("event device timezone served-markup pins", () => {
  it("serves the Hono action hidden with an empty result region", () => {
    // A fresh server render never shows a focusable dead button (no-JS keeps
    // the host presentation) and never pre-fills a conversion: the island
    // unhides the action only after it binds, and fills the result only on
    // activation. Removing `hidden` or pre-filling the region must fail here.
    const html = String(
      EventPage({
        e: eventFixture(),
        neighbors: { previous: null, next: null },
        related: [],
        appUrl: APP_URL,
        jsonLd: "{}",
      }),
    );
    const mount = html.slice(html.indexOf("data-event-device-timezone"));
    expect(mount).toMatch(
      /<button type="button" hidden[^>]*>\s*Show in my device timezone\s*<\/button>/,
    );
    expect(mount).toContain('<p role="status" aria-live="polite"></p>');
  });
});
