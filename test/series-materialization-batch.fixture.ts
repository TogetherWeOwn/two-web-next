import type { EventRow } from "../src/admin/store-event-writes";

export const SERIES_ACTOR = { id: "246810121416182022", username: "fixture moderator" };
export const SERIES_CREATOR = "135791113151719212";
export const SERIES_INSTANT = new Date("2030-01-06T20:00:00.123Z");
export const SERIES_END = new Date("2030-01-06T22:15:00.456Z");

export function seriesParent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 101,
    eventKey: "01K00000000000000000000000",
    title: "Weekly co-op — all welcome",
    game: "Deep Rock Galactic",
    description: "Bring a new character.\nNo prior campaign needed.",
    accessibilityNotes: "Captions on; text-only participation is welcome.",
    startsAt: SERIES_INSTANT,
    endsAt: SERIES_END,
    timezone: "Europe/London",
    location: "Community voice room",
    organizer_name: "Fixture host",
    join_url: "https://example.com/weekly-room",
    join_instructions: "Ask for the private room in chat.",
    capacity: 17,
    status: "published",
    discordEventId: "fixture-existing-discord-event",
    syncRevision: 8,
    syncedRevision: 7,
    discordSyncFailedAt: new Date("2029-12-01T12:00:00.000Z"),
    discordSyncFailureCode: "fixture_failure",
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 4,
    createdBy: SERIES_CREATOR,
    rsvpOpen: false,
    recurrenceFrequency: "weekly",
    recurrenceCount: 52,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: 1,
    createdAt: new Date("2029-12-01T12:00:00.000Z"),
    updatedAt: new Date("2029-12-02T12:00:00.000Z"),
    icsSequence: 9n,
    ...overrides,
  };
}

/** Literal creation-audit contract, deliberately independent of the production dirty helper. */
export function expectedCreationProperties(
  row: EventRow,
  parentId = 101,
  creator: string | null = SERIES_CREATOR,
) {
  return {
    id: { before: null, after: row.id },
    eventKey: { before: null, after: row.eventKey },
    title: { before: null, after: "Weekly co-op — all welcome" },
    game: { before: null, after: "Deep Rock Galactic" },
    description: { before: null, after: "Bring a new character.\nNo prior campaign needed." },
    accessibilityNotes: {
      before: null,
      after: "Captions on; text-only participation is welcome.",
    },
    startsAt: { before: null, after: row.startsAt.toISOString() },
    endsAt: { before: null, after: row.endsAt.toISOString() },
    timezone: { before: null, after: "Europe/London" },
    location: { before: null, after: "Community voice room" },
    organizer_name: { before: null, after: "Fixture host" },
    join_url: { before: null, after: "https://example.com/weekly-room" },
    join_instructions: { before: null, after: "Ask for the private room in chat." },
    capacity: { before: null, after: 17 },
    status: { before: null, after: "draft" },
    syncRevision: { before: null, after: row.syncRevision },
    syncedRevision: { before: null, after: 0 },
    agentVersion: { before: null, after: 1 },
    createdBy: { before: null, after: creator },
    rsvpOpen: { before: null, after: true },
    parentEventId: { before: null, after: parentId },
    recurrenceIndex: { before: null, after: row.recurrenceIndex },
    createdAt: { before: null, after: row.createdAt.toISOString() },
    updatedAt: { before: null, after: row.updatedAt.toISOString() },
  };
}
