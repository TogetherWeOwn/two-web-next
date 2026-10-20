import { jsx } from "hono/jsx/jsx-runtime";
import { EventsCalendarPage } from "../../src/events/pages";
import type { PublicEvent } from "../../src/events/reads";
import type { CalendarState, DiscordTransient } from "../../src/islands/contracts";
import { renderEventsHtml } from "../../src/kit-events-html";

// Hand-derived wall-day expectations, never calculated using the production
// interval/month helpers. Calendar February 2027 has no neighbouring cells.
export const intervalCases = [
  {
    name: "same host day",
    month: "2027-02",
    start: "2027-02-14T12:00:00Z",
    end: "2027-02-14T14:00:00Z",
    zone: "UTC",
    days: ["2027-02-14"],
  },
  {
    name: "overnight",
    month: "2027-02",
    start: "2027-02-14T23:30:00Z",
    end: "2027-02-15T01:00:00Z",
    zone: "UTC",
    days: ["2027-02-14", "2027-02-15"],
  },
  {
    name: "exclusive midnight end",
    month: "2027-02",
    start: "2027-02-14T23:30:00Z",
    end: "2027-02-15T00:00:00Z",
    zone: "UTC",
    days: ["2027-02-14"],
  },
  {
    name: "month spanning",
    month: "2027-02",
    start: "2027-01-31T23:00:00Z",
    end: "2027-02-02T01:00:00Z",
    zone: "UTC",
    days: ["2027-02-01", "2027-02-02"],
  },
  {
    name: "year spanning with a leading neighbour day",
    month: "2028-01",
    start: "2027-12-31T23:00:00Z",
    end: "2028-01-02T00:00:00Z",
    zone: "UTC",
    days: ["2027-12-31", "2028-01-01"],
  },
  {
    name: "start before the leading week",
    month: "2027-02",
    start: "2027-01-20T12:00:00Z",
    end: "2027-02-03T01:00:00Z",
    zone: "UTC",
    days: ["2027-02-01", "2027-02-02", "2027-02-03"],
  },
  {
    name: "end beyond the trailing week",
    month: "2027-02",
    start: "2027-02-27T23:00:00Z",
    end: "2027-03-10T01:00:00Z",
    zone: "UTC",
    days: ["2027-02-27", "2027-02-28"],
  },
  {
    name: "spring-forward from a late wall start",
    month: "2027-03",
    start: "2027-03-14T04:30:00Z", // March 13 23:30 EST
    end: "2027-03-16T04:00:00Z", // March 16 00:00 EDT
    zone: "America/New_York",
    days: ["2027-03-13", "2027-03-14", "2027-03-15"],
  },
  {
    name: "23-hour spring-forward day ends at host midnight",
    month: "2027-03",
    start: "2027-03-14T05:00:00Z",
    end: "2027-03-15T04:00:00Z",
    zone: "America/New_York",
    days: ["2027-03-14"],
  },
  {
    name: "fall-back includes each wall day once",
    month: "2027-11",
    start: "2027-11-07T03:30:00Z", // November 6 23:30 EDT
    end: "2027-11-08T05:30:00Z", // November 8 00:30 EST
    zone: "America/New_York",
    days: ["2027-11-06", "2027-11-07", "2027-11-08"],
  },
  {
    name: "25-hour fall-back day ends at host midnight",
    month: "2027-11",
    start: "2027-11-07T04:00:00Z",
    end: "2027-11-08T05:00:00Z",
    zone: "America/New_York",
    days: ["2027-11-07"],
  },
  {
    name: "positive-offset host days, not UTC dates",
    month: "2027-02",
    start: "2027-02-14T09:30:00Z", // February 14 23:30 +14
    end: "2027-02-14T11:00:00Z", // February 15 01:00 +14
    zone: "Pacific/Kiritimati",
    days: ["2027-02-14", "2027-02-15"],
  },
  {
    name: "invalid host zone falls back to UTC",
    month: "2027-02",
    start: "2027-02-14T23:30:00Z",
    end: "2027-02-15T01:00:00Z",
    zone: "invalid-zone",
    days: ["2027-02-14", "2027-02-15"],
  },
  {
    name: "exclusive end at the first grid midnight",
    month: "2027-02",
    start: "2027-01-20T12:00:00Z",
    end: "2027-02-01T00:00:00Z",
    zone: "UTC",
    days: [],
  },
  {
    name: "entire interval after the grid",
    month: "2027-02",
    start: "2027-03-01T00:00:00Z",
    end: "2027-03-10T12:00:00Z",
    zone: "UTC",
    days: [],
  },
];

export const gatheringKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const gatheringTitle = "Multi-day gathering";
export type CanonicalFixture = PublicEvent;
export type CalendarRow = PublicEvent | DiscordTransient;
export type CalendarTwin = "Hono" | "Kit";

export async function renderCalendar(
  twin: CalendarTwin,
  upcoming: CalendarRow[],
  options: {
    month?: string;
    view?: "calendar" | "list";
    zone?: string;
    past?: PublicEvent[];
    showPast?: boolean;
  } = {},
): Promise<string> {
  const state: CalendarState = {
    view: options.view ?? "calendar",
    month: options.month ?? "2027-02",
    q: "",
    past: options.showPast ?? false,
    page: 1,
  };
  const data = {
    state,
    upcoming,
    past: options.past ?? [],
    zone: options.zone ?? "UTC",
    now: new Date("2027-01-15T12:00:00Z"),
    totalPages: 1,
    emptyState: null,
    robots: undefined,
    discordFailed: false,
    member: false,
    moderator: false,
    inviteUrl: "https://discord.gg/fixture",
    appUrl: "https://calendar.example.test",
    canonical: "https://calendar.example.test/events",
    loginReturnTo: "/events",
    joinResult: null,
    queryTooLong: false,
  };
  return twin === "Hono"
    ? await jsx(EventsCalendarPage, data).toString()
    : (await renderEventsHtml(data, {})).body;
}

export function calendarLinks(html: string) {
  return [...html.matchAll(/<td\b[^>]*data-date="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)].flatMap(
    (cell) =>
      [...cell[2]!.matchAll(/<a\b([^>]*\bdata-cal-jump[^>]*)>([\s\S]*?)<\/a>/g)].map((link) => ({
        day: cell[1]!,
        href: (/href="([^"]*)"/.exec(link[1]!)?.[1] ?? "").replaceAll("&amp;", "&"),
        name: /aria-label="([^"]*)"/.exec(link[1]!)?.[1] ?? "",
        text: link[2]!.replace(/<[^>]+>/g, "").trim(),
      })),
  );
}

export function gathering(overrides: Partial<CanonicalFixture> = {}): CanonicalFixture {
  const startsAt = new Date("2027-02-14T23:30:00Z");
  return {
    id: 1,
    icsSequence: 1n,
    syncRevision: 1,
    syncedRevision: 0,
    eventKey: gatheringKey,
    title: gatheringTitle,
    game: "Co-op",
    description: "One gathering, one RSVP, continuing across calendar days.",
    startsAt,
    endsAt: new Date("2027-02-15T01:00:00Z"),
    timezone: "UTC",
    location: "Voice",
    capacity: 8,
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
    goingCount: 2,
    goingOccupancy: 2,
    ...overrides,
  };
}
