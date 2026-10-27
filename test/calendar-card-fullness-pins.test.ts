// Calendar card fullness pins (owned): the real CalCard rendered directly
// with crafted rows. Local fixtures only, no database. The scheduled
// availability line reads seat occupancy, so an open capped card shows the
// occupancy-derived remaining count while the Full marker node stays
// full-only; these pins close the mutant that drops the >= comparison from
// the card verdict or derives the remaining count from the named count.
// The end-date pins extract the second <time> element's inner text so its
// machine-readable datetime attribute cannot satisfy a visible-label pin.
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import { CalCard } from "../src/events/pages-calendar-card";
import type { PublicEvent } from "../src/events/reads";

type EventRow = typeof events.$inferSelect;

function cardRow(
  over: Partial<EventRow> &
    Pick<PublicEvent, "goingCount" | "goingOccupancy"> & {
      capacity: number | null;
    },
): PublicEvent {
  const startsAt = new Date(Date.UTC(2030, 6, 20, 19));
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: "game-night-1",
    // The title must not contain "Full": negative marker pins assert on it.
    title: "Game night",
    game: null,
    description: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    syncRevision: 1,
    syncedRevision: 0,
    ...over,
  };
}

const render = (e: PublicEvent): string =>
  CalCard({
    e,
    zone: "Europe/London",
    now: new Date(Date.UTC(2030, 0, 1)),
    isPast: false,
    member: true,
    inviteUrl: "https://discord.gg/invite",
    loginReturnTo: null,
  })!.toString() as string;

describe("calendar card fullness pins", () => {
  it("keeps legacy callers without a model instant safe for elapsed events", () => {
    const html = String(
      CalCard({
        e: cardRow({
          goingCount: 1,
          goingOccupancy: 1,
          capacity: 4,
          startsAt: new Date("2000-01-01T19:00:00Z"),
          endsAt: new Date("2000-01-01T21:00:00Z"),
        }),
        zone: "UTC",
        isPast: false,
        member: true,
        inviteUrl: "https://discord.gg/invite",
        loginReturnTo: null,
      }),
    );
    expect(html).toContain(">Ended<");
    expect(html).not.toContain("3 seats left");
  });

  it("shows remaining seats from occupancy on an open capped card, never the Full marker", () => {
    const html = render(cardRow({ goingCount: 1, goingOccupancy: 1, capacity: 4 }));
    expect(html).toContain("1 of 4 going");
    expect(html).toContain('data-testid="event-schedule-availability"');
    expect(html).toContain("3 seats left");
    expect(html).not.toContain("event-spots-left");
    expect(html).not.toContain(">Full<");
  });

  it("keeps past draft cards unmarked even with retained responses at capacity", () => {
    const html = String(
      CalCard({
        e: cardRow({
          status: "draft",
          goingCount: 3,
          goingOccupancy: 10,
          capacity: 10,
          startsAt: new Date("2029-12-30T19:00:00Z"),
          endsAt: new Date("2029-12-30T21:00:00Z"),
        }),
        zone: "UTC",
        now: new Date("2030-01-01T12:00:00Z"),
        isPast: true,
        member: true,
        inviteUrl: "https://discord.gg/invite",
        loginReturnTo: null,
      }),
    );
    expect(html).toContain(">Draft<");
    expect(html).toContain("3 of 10 going");
    expect(html).not.toContain('data-testid="event-spots-left"');
    expect(html).not.toContain(">Full<");
    expect(html).not.toContain('data-testid="event-schedule-availability"');
  });

  it("marks a full card from occupancy even when the named count has room", () => {
    // Control for the negative above: the same renderer and row shape carry
    // the marker when occupancy reaches capacity, so the open-card absence
    // is a verdict, not a missing node.
    const html = render(cardRow({ goingCount: 1, goingOccupancy: 2, capacity: 2 }));
    expect(html).toContain("1 of 2 going");
    expect(html).toContain('data-testid="event-spots-left"');
    expect(html).toContain(">Full<");
  });
});

// Visible end-date pins: inner text of the second <time> element only, so a
// datetime attribute can never satisfy a visible-label assertion. The card
// renders the end label as plain text (no nested markup), so the helper
// asserts that directly instead of stripping tags.
function endTimeText(html: string): string {
  const bodies = [...html.matchAll(/<time\b[^>]*>([\s\S]*?)<\/time>/g)].map((match) => match[1]!);
  expect(bodies, "card renders a start and an end time").toHaveLength(2);
  const text = bodies[1]!;
  expect(text, "end time has no nested markup").not.toContain("<");
  return text;
}

describe("calendar card end-date visible-text pins", () => {
  it("shows the end year in visible text when the year changes", () => {
    const html = render(
      cardRow({
        goingCount: 3,
        goingOccupancy: 3,
        capacity: 8,
        startsAt: new Date("2030-12-31T23:30:00Z"),
        endsAt: new Date("2031-01-01T01:00:00Z"),
        timezone: "Europe/London",
      }),
    );
    expect(endTimeText(html)).toBe("Wed 1 Jan 2031, 01:00");
  });

  it("keeps a same-day end clock-only with no year in visible text", () => {
    const html = render(cardRow({ goingCount: 1, goingOccupancy: 1, capacity: 4 }));
    expect(endTimeText(html)).toBe("22:00");
  });

  it("shows the end date without the year when only the day changes", () => {
    const html = render(
      cardRow({
        goingCount: 3,
        goingOccupancy: 3,
        capacity: 8,
        startsAt: new Date("2030-06-02T06:30:00Z"),
        endsAt: new Date("2030-06-02T08:30:00Z"),
        timezone: "America/Los_Angeles",
      }),
    );
    expect(endTimeText(html)).toBe("Sun 2 Jun, 01:30");
  });
});
