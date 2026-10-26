import type { events } from "../../src/db/admin-schema";

export type CalendarRow = typeof events.$inferSelect;
export const APP_URL = "https://next.example.test";
export const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const OTHER_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

export function calendarRow(overrides: Partial<CalendarRow> = {}): CalendarRow {
  return {
    id: 1,
    eventKey: KEY,
    title: "Friday night Helldivers",
    game: null,
    description: "Bring stims.",
    startsAt: new Date("2026-07-15T18:00:00Z"),
    endsAt: new Date("2026-07-15T20:00:00Z"),
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: null,
    status: "published",
    rsvpOpen: true,
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
    icsSequence: 1782907200n,
    syncRevision: 1,
    syncedRevision: 0,
    createdAt: new Date("2026-07-01T12:00:00Z"),
    updatedAt: new Date("2026-07-01T12:00:00Z"),
    ...overrides,
  };
}

// Hand-derived wire fixture, not computed with a production encoder.
export function healthyVevent(key = KEY, game: string | null = null): string {
  return [
    "BEGIN:VEVENT",
    `UID:${key}@next.example.test`,
    "SEQUENCE:82907200",
    "DTSTAMP:20260701T120000Z",
    "DTSTART:20260715T180000Z",
    "DTEND:20260715T200000Z",
    "SUMMARY:Friday night Helldivers",
    "STATUS:CONFIRMED",
    "DESCRIPTION:Bring stims.",
    "LOCATION:Voice: General",
    ...(game === null ? [] : [`CATEGORIES:${game}`]),
    `URL:${APP_URL}/e/${key}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Friday night Helldivers",
    "END:VALARM",
    "END:VEVENT",
    "",
  ].join("\r\n");
}

export function calendarBytes(...vevents: string[]): string {
  return (
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//TogetherWeOwn//Events//EN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Together We Own Events",
      "X-WR-CALDESC:Upcoming events from Together We Own",
      "REFRESH-INTERVAL;VALUE=DURATION:PT5M",
      "X-PUBLISHED-TTL:PT5M",
      "",
    ].join("\r\n") +
    vevents.join("") +
    "END:VCALENDAR\r\n"
  );
}
