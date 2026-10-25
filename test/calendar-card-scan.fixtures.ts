import { CalCard } from "../src/events/pages-calendar-card";
import type { CalRow } from "../src/events/pages-calendar-row";
import type { PublicEvent } from "../src/events/reads";
import { gathering } from "./helpers/calendar-multiday-acceptance";

// Independent acceptance choice: count Unicode code points, not UTF-16 units.
// Persisted and Discord rows share the same disclosure boundary.
export const DESCRIPTION_LIMIT = 240;
export const FULL_DESCRIPTION =
  "SCAN-BEGIN " + "Bring a game and meet the community. ".repeat(23) + " SCAN-END";
export const EVENT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

export function scanEvent(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return gathering({
    eventKey: EVENT_KEY,
    title: "Community overnight games",
    game: "Tabletop",
    description: FULL_DESCRIPTION,
    startsAt: new Date("2030-06-02T06:30:00Z"),
    endsAt: new Date("2030-06-02T08:30:00Z"),
    timezone: "America/Los_Angeles",
    location: "Community lounge",
    goingCount: 3,
    goingOccupancy: 3,
    ...overrides,
  });
}

export function cardHtml(e: CalRow, member = false, zone = "UTC"): string {
  return String(
    CalCard({
      e,
      zone,
      member,
      isPast: false,
      inviteUrl: "https://discord.com/invite/example",
      loginReturnTo: "/events?view=list&month=2030-06",
    }),
  );
}

// Endpoint dates, not the grid's exclusive-end day-membership rules.
// Literal oracles deliberately do not call the production formatter.
export const cardRanges = [
  {
    name: "same day",
    start: "2030-06-02T12:00:00Z",
    end: "2030-06-02T14:00:00Z",
    zone: "UTC",
    endClock: "14:00",
    endDate: null,
  },
  {
    name: "same host day across UTC midnight",
    start: "2030-06-01T23:00:00Z",
    end: "2030-06-02T01:00:00Z",
    zone: "America/Los_Angeles",
    endClock: "18:00",
    endDate: null,
  },
  {
    name: "overnight in the host zone but not UTC",
    start: "2030-06-02T06:30:00Z",
    end: "2030-06-02T08:30:00Z",
    zone: "America/Los_Angeles",
    endClock: "01:30",
    endDate: /(?:2\s+Jun|Jun\w*\s+2\b|2030-06-02)/,
  },
  {
    name: "multiple days",
    start: "2030-06-01T12:00:00Z",
    end: "2030-06-04T14:00:00Z",
    zone: "UTC",
    endClock: "14:00",
    endDate: /(?:4\s+Jun|Jun\w*\s+4\b|2030-06-04)/,
  },
  {
    name: "month boundary ending at midnight",
    start: "2030-06-30T23:30:00Z",
    end: "2030-07-01T00:00:00Z",
    zone: "UTC",
    endClock: "00:00",
    endDate: /(?:1\s+Jul|Jul\w*\s+1\b|2030-07-01)/,
  },
  {
    name: "year boundary",
    start: "2030-12-31T23:30:00Z",
    end: "2031-01-01T01:00:00Z",
    zone: "Europe/London",
    endClock: "01:00",
    endDate: /(?:1\s+Jan|Jan\w*\s+1\b|2031-01-01)/,
    endYear: "2031",
  },
  {
    name: "spring DST gap",
    start: "2030-03-10T09:30:00Z",
    end: "2030-03-10T10:30:00Z",
    zone: "America/Los_Angeles",
    endClock: "03:30",
    endDate: null,
  },
  {
    name: "fall DST repeated hour",
    start: "2030-11-03T08:30:00Z",
    end: "2030-11-03T09:30:00Z",
    zone: "America/Los_Angeles",
    endClock: "01:30",
    endDate: null,
  },
  {
    name: "invalid zone keeps UTC fallback",
    start: "2030-06-01T23:30:00Z",
    end: "2030-06-02T01:00:00Z",
    zone: "Not/A_Zone",
    endClock: "01:00",
    endDate: /(?:2\s+Jun|Jun\w*\s+2\b|2030-06-02)/,
  },
];
