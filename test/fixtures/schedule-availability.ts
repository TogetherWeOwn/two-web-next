import { jsx } from "hono/jsx/jsx-runtime";
import { EventsCalendarPage } from "../../src/events/pages";
import type { PublicEvent } from "../../src/events/reads";
import type { CalendarState, DiscordTransient } from "../../src/islands/contracts";
import type { KitEventsLoadData } from "../../src/kit-events";
import { renderEventsHtml } from "../../src/kit-events-html";

export const NOW = new Date("2035-10-20T12:00:00Z");
export const ORIGIN = "https://schedule.example";
export const KEY = "01K7MZ00000000000000000001";
export const TITLE = "Cooperative expedition night";

export function event(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: 1,
    eventKey: KEY,
    title: TITLE,
    game: "Deep Rock Galactic",
    description: "A relaxed cooperative night.",
    accessibilityNotes: null,
    startsAt: new Date("2035-10-21T18:00:00Z"),
    endsAt: new Date("2035-10-21T20:00:00Z"),
    timezone: "UTC",
    location: "Community voice",
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    capacity: 10,
    goingCount: 3,
    goingOccupancy: 8,
    rsvpOpen: true,
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
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: new Date("2035-10-01T12:00:00Z"),
    updatedAt: new Date("2035-10-01T12:00:00Z"),
    icsSequence: 0n,
    ...overrides,
  };
}

export function discordEvent(): DiscordTransient {
  return {
    discordId: "123456789012345678",
    status: "scheduled",
    title: "Discord community night",
    description: "Managed outside the website.",
    location: "Discord voice",
    startsAt: new Date("2035-10-21T19:00:00Z"),
    endsAt: new Date("2035-10-21T21:00:00Z"),
  };
}

export function model(
  upcoming: (PublicEvent | DiscordTransient)[],
  state: Partial<CalendarState> = {},
  past: PublicEvent[] = [],
): KitEventsLoadData {
  return {
    queryTooLong: false,
    state: { view: "list", month: "2035-10", q: "", game: "", past: false, page: 1, ...state },
    upcoming,
    past,
    pastMayBeTruncated: false,
    zone: "UTC",
    now: NOW,
    totalPages: 3,
    emptyState: null,
    discordFailed: false,
    games: ["Deep Rock Galactic"],
    gameFilter: state.game || null,
    member: false,
    moderator: false,
    session: null,
    inviteUrl: "https://discord.gg/example",
    appUrl: ORIGIN,
    canonical: `${ORIGIN}/events`,
    loginReturnTo: "/events",
    joinResult: null,
  };
}

export async function render(data: KitEventsLoadData, target: "Hono" | "Kit"): Promise<string> {
  if (target === "Kit") return (await renderEventsHtml(data, {})).body;
  return await jsx(EventsCalendarPage, { ...data }).toString();
}

// Semantic alternatives leave the builder free to choose concise copy, not the state or number.
export const PAUSED = /RSVPs?\s+(?:are\s+)?paused/i;
export const FULL = /\bfull\b/i;
export const CANCELLED = /\bcancelled\b/i;
export const PAST = /\b(?:past|ended|finished)\b/i;
export const TWO_LEFT =
  /\b2\s+(?:seats?|spots?|places?)\s+(?:left|remaining|available)\b|\b(?:seats?|spots?|places?)\s+(?:left|remaining|available)\s*:\s*2\b/i;
export const UNLIMITED = /\b(?:no\s+(?:seat|capacity)\s+limit|unlimited|uncapped|no\s+limit)\b/i;
export const DISCORD_MANAGED =
  /\bDiscord[\s-]managed\b|\b(?:capacity|availability)\s+(?:is\s+)?unknown\b/i;
export const BOOKABLE =
  /\b\d+\s+(?:seats?|spots?|places?)\s+(?:left|remaining|available)\b|\b(?:seats?|spots?|places?)\s+(?:left|remaining|available)\s*:\s*\d+\b|\b(?:unlimited|uncapped|no\s+(?:(?:seat|capacity)\s+)?limit)\b/i;
