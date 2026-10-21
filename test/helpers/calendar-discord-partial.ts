import type { CalendarPageModel } from "../../src/events/page-models.server";
import type { PublicEvent } from "../../src/events/reads";
import { renderEventsHtml } from "../../src/kit-events-html";

// Synthetic public data only. Both renderers and the shipped browser binder
// consume these fixtures; no fixture needs a database or Discord request.
export const PARTIAL_ORIGIN = "https://localhost:8787";
export const PARTIAL_INVITE = "https://discord.gg/example";
export const MISSING_DISCORD =
  /Discord[\s\S]*(?:missing|unavailable|unreachable|couldn.t|can.t|not[^.]*load)/i;
export const RETRY_NAME = /try again|retry|refresh/i;
export const PARTIAL_PATH = "/events?past=1&page=2";

export function partialEvent(id = 1): PublicEvent {
  const startsAt = new Date("2099-05-12T20:00:00Z");
  return {
    id,
    icsSequence: 1n,
    syncRevision: 1,
    syncedRevision: 0,
    eventKey: `local-night-${id}`,
    title: `Local chess night ${id}`,
    game: null,
    description: "A healthy community event",
    startsAt,
    endsAt: new Date("2099-05-12T22:00:00Z"),
    timezone: "UTC",
    location: null,
    capacity: null,
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
    goingCount: 0,
    goingOccupancy: 0,
  };
}

export function partialModel(overrides: Partial<CalendarPageModel> = {}): CalendarPageModel {
  return {
    state: { view: "list", month: "2099-05", q: "", past: true, page: 2 },
    upcoming: [partialEvent()],
    past: [],
    zone: "UTC",
    totalPages: 3,
    emptyState: null,
    discordFailed: true,
    ...overrides,
  };
}

export async function partialHtml(
  model = partialModel(),
  origin = PARTIAL_ORIGIN,
  // The shipped island admits a fragment only when its auth destinations
  // return to the requested page, matching SSR (routes-calendar always sets
  // loginReturnTo from the request path). Pass the request path so fragment
  // turns stay committable; the default keeps the entry-page value.
  loginReturnTo = PARTIAL_PATH,
) {
  return (
    await renderEventsHtml(
      {
        ...model,
        now: new Date("2099-05-01T12:00:00Z"),
        member: false,
        moderator: false,
        inviteUrl: PARTIAL_INVITE,
        appUrl: origin,
        canonical: `${origin}/events`,
        loginReturnTo,
        joinResult: null,
        queryTooLong: false,
      },
      { "cache-control": "private, no-store" },
    )
  ).body;
}

export function discordNotices(html: string): string[] {
  // Accept semantic status or alert wrappers, not an implementation-specific id
  // or exact wording. This extracts rendered content, never source literals.
  return [
    ...html.matchAll(/<(p|div|aside|section)\b[^>]*role="(?:status|alert)"[^>]*>([\s\S]*?)<\/\1>/g),
  ]
    .map((match) => match[2]!)
    .filter((body) => MISSING_DISCORD.test(body.replace(/<[^>]*>/g, " ")));
}
