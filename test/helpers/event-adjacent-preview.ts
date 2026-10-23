import type { Db } from "../../src/db/index";
import type { Env } from "../../src/env";
import { resolveKitEventDetail } from "../../src/events/kit-detail";
import { EventPage } from "../../src/events/pages-detail";
import type { EventNeighbors, EventSeriesContext, PublicEvent } from "../../src/events/reads";
import { renderSeriesDetail } from "./event-series-context-render";

export const adjacentKey = (id: number) => String(id).padStart(26, "0");
export type DetailTwin = "Hono" | "Kit";
export function adjacentEvent(id = 20, over: Partial<PublicEvent> = {}): PublicEvent {
  const startsAt = new Date("2030-06-14T19:00:00Z");
  return {
    id,
    eventKey: adjacentKey(id),
    title: "Friday game night",
    game: "Chess",
    description: null,
    accessibilityNotes: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "UTC",
    location: "Current event lobby",
    organizer_name: "Riley",
    join_url: null,
    join_instructions: null,
    capacity: null,
    status: "published",
    rsvpOpen: true,
    icsSequence: 1n,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    goingCount: 0,
    goingOccupancy: 0,
    createdAt: startsAt,
    updatedAt: startsAt,
    ...over,
  };
}
export const previewNeighbors: EventNeighbors = {
  previous: adjacentEvent(10, {
    startsAt: new Date("2030-06-07T19:00:00Z"),
    timezone: "America/New_York",
    location: "West room",
  }),
  next: adjacentEvent(30, {
    startsAt: new Date("2030-06-21T19:00:00Z"),
    timezone: "Europe/London",
    location: "East room",
  }),
};

// Only the persistence seams are replaced. Hono's real page, Kit's real model
// formatting and the real Svelte SSR view remain under test. No client HTML.
export async function renderAdjacentDetail(
  twin: DetailTwin,
  options: {
    event?: PublicEvent;
    neighbors?: EventNeighbors;
    series?: EventSeriesContext | null;
  } = {},
): Promise<string> {
  const event = options.event ?? adjacentEvent();
  const neighbors = options.neighbors ?? previewNeighbors;
  const series = options.series === undefined ? { hosts: ["Riley"], ...neighbors } : options.series;
  const appUrl = "https://adjacent.example.test";
  if (twin === "Hono") {
    return String(
      await EventPage({ e: event, neighbors, series, related: [], appUrl, jsonLd: "{}" }),
    );
  }
  const outcome = await resolveKitEventDetail({
    key: event.eventKey,
    search: "",
    path: `/e/${event.eventKey}`,
    env: { APP_URL: appUrl } as Env,
    session: { status: "guest", session: null },
    joinResult: null,
    setHeaders: () => {},
    store: {
      dbForFn: async () => ({}) as Db,
      getEventFn: async () => event,
      neighborsFn: async () => neighbors,
      seriesFn: async () => series,
      relatedFn: async () => [],
      attendeesFn: async () => [],
      viewerRsvpFn: async () => null,
      waitlistFn: async () => null,
      suggestionsFn: async () => [],
    },
  });
  if (outcome.kind !== "ok") throw new Error(`Fixture expected ok, got ${outcome.kind}`);
  const rendered = await renderSeriesDetail(outcome.model as unknown as Record<string, unknown>);
  // These document-level fields normally come from Kit's app.html, not Shell.
  return `<!doctype html><html lang="en">${rendered.replace(
    "<head>",
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  )}</html>`;
}
