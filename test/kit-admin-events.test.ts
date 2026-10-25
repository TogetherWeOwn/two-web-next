// Kit moderator events-list view model: the serializable slice the events
// load renders. listEvents over-fetches by exactly one row (no count query),
// so the view cuts to the page size and reports the next-page flag; the
// query, empty copy and pre-rendered timestamps match the Hono EventsPage.
import { describe, expect, it } from "vitest";
import { EVENT_PAGE_SIZE, parseEventListQuery } from "../src/admin/event-list";
import { buildEventListView, serializeEventListRow } from "../src/admin/kit-events";
import type { EventListRow } from "../src/admin/store-event-reads";

function row(key: string, overrides: Partial<EventListRow> = {}): EventListRow {
  return {
    id: 1,
    eventKey: key,
    title: `Game night ${key}`,
    game: null,
    description: null,
    startsAt: new Date("2026-11-01T18:00:00.000Z"),
    endsAt: new Date("2026-11-01T21:00:00.000Z"),
    timezone: "UTC",
    location: null,
    capacity: 8,
    status: "published",
    discordEventId: null,
    syncRevision: 1,
    syncedRevision: 1,
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
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    icsSequence: 0n,
    goingCount: 3,
    ...overrides,
  };
}

describe("Kit events-list view model", () => {
  it("serializes timestamps to the ISO strings the Hono page emits", () => {
    expect(serializeEventListRow(row("EVT1"))).toEqual({
      eventKey: "EVT1",
      title: "Game night EVT1",
      game: null,
      status: "published",
      startsAt: "2026-11-01T18:00:00.000Z",
      endsAt: "2026-11-01T21:00:00.000Z",
      capacity: 8,
      rsvpOpen: true,
      goingCount: 3,
    });
  });

  it("slices the over-fetched page and flags the next page", () => {
    const query = parseEventListQuery({ page: "2" });
    const fetched = Array.from({ length: EVENT_PAGE_SIZE + 1 }, (_, i) =>
      row(`EVT${i}`, { id: i + 1 }),
    );
    const view = buildEventListView(query, fetched);
    expect(view.query).toEqual(query);
    expect(view.rows).toHaveLength(EVENT_PAGE_SIZE);
    expect(view.rows.map((r) => r.eventKey)).toEqual(
      fetched.slice(0, EVENT_PAGE_SIZE).map((r) => r.eventKey),
    );
    expect(view.hasNext).toBe(true);
  });

  it("reports no next page on a short final page", () => {
    const query = parseEventListQuery({});
    const view = buildEventListView(query, [row("EVT1")]);
    expect(view.rows).toHaveLength(1);
    expect(view.hasNext).toBe(false);
  });

  it("matches the Hono empty copy for blank and filtered queries", () => {
    expect(buildEventListView(parseEventListQuery({}), []).emptyText).toBe("No events yet.");
    expect(buildEventListView(parseEventListQuery({ q: "nothing" }), []).emptyText).toBe(
      "No events match these filters.",
    );
    expect(buildEventListView(parseEventListQuery({ status: "draft" }), []).emptyText).toBe(
      "No events match these filters.",
    );
  });
});
