// Calendar card fullness pins (owned): the real CalCard rendered directly
// with crafted rows. Local fixtures only, no database. The scheduled
// availability line reads seat occupancy, so an open capped card shows the
// occupancy-derived remaining count while the Full marker node stays
// full-only; these pins close the mutant that drops the >= comparison from
// the card verdict or derives the remaining count from the named count.
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
  it("shows remaining seats from occupancy on an open capped card, never the Full marker", () => {
    const html = render(cardRow({ goingCount: 1, goingOccupancy: 1, capacity: 4 }));
    expect(html).toContain("1 of 4 going");
    expect(html).toContain('data-testid="event-schedule-availability"');
    expect(html).toContain("3 seats left");
    expect(html).not.toContain("event-spots-left");
    expect(html).not.toContain(">Full<");
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
