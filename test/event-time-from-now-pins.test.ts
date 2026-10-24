// Implementation-owned pins for the time-from-now row. The independent
// acceptance contract is test/event-time-from-now-acceptance.test.ts and
// ci/event-time-from-now.test.mjs (Test Author owned, never edited here);
// these cases pin what they do not: the instants the island reads equal the
// visible host <time> values, the island is loaded, and the row is not
// offered on drafts.
import { describe, expect, it } from "vitest";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";

function render(status: PublicEvent["status"]) {
  const start = new Date("2030-01-10T20:00:00Z");
  const e = {
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
    status,
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
  } as PublicEvent;
  return String(
    EventPage({
      e,
      neighbors: { previous: null, next: null },
      related: [],
      appUrl: "https://next.example.test",
      jsonLd: "{}",
    }),
  );
}

describe("event time-from-now served-markup pins", () => {
  it("serves a hidden row whose instants equal the visible host times", () => {
    const html = render("published");
    const row = html.slice(html.indexOf("<dt>Time from now</dt>"));
    expect(row).toContain('data-starts-at="2030-01-10T20:00:00.000Z"');
    expect(row).toContain('data-ends-at="2030-01-10T22:00:00.000Z"');
    expect(html).toContain('<time datetime="2030-01-10T20:00:00.000Z">');
    expect(html).toContain('<time datetime="2030-01-10T22:00:00.000Z">');
    // The whole row is hidden until the island binds, so no-JS shows no dead label.
    expect(html.slice(0, html.indexOf("<dt>Time from now</dt>"))).toMatch(/<div hidden="">$/);
    expect(html).toContain('<script src="/islands/event-time-from-now.js" defer="">');
  });
  it("does not offer the action on a draft", () => {
    expect(render("draft")).not.toContain("data-event-time-from-now");
  });
});
