import type { DiscordTransient } from "../../src/islands/contracts";
import { gathering, type CalendarRow } from "../helpers/calendar-multiday-acceptance";
import { scheduleCases } from "./event-scheduled-range";
import { scheduledEvent } from "../helpers/event-scheduled-range";

// Hand-derived elapsed intervals, not differences between formatted wall clocks.
export const durationCases = [
  {
    name: "90 minutes",
    start: "2030-06-01T18:00:00Z",
    end: "2030-06-01T19:30:00Z",
    zone: "Europe/London",
    milliseconds: 5_400_000,
    want: "1 hour 30 minutes",
  },
  {
    name: "overnight",
    start: "2030-06-01T23:30:00Z",
    end: "2030-06-02T01:15:00Z",
    zone: "UTC",
    milliseconds: 6_300_000,
    want: "1 hour 45 minutes",
  },
  {
    name: "more than a day",
    start: "2030-06-01T12:00:00Z",
    end: "2030-06-02T14:05:00Z",
    zone: "Pacific/Kiritimati",
    milliseconds: 93_900_000,
    want: "26 hours 5 minutes",
  },
  {
    name: "London spring gap",
    start: "2030-03-31T00:30:00Z",
    end: "2030-03-31T01:30:00Z",
    zone: "Europe/London",
    milliseconds: 3_600_000,
    want: "1 hour",
  },
  {
    name: "London repeated hour",
    start: "2030-10-27T00:30:00Z",
    end: "2030-10-27T01:30:00Z",
    zone: "Europe/London",
    milliseconds: 3_600_000,
    want: "1 hour",
  },
  {
    name: "New York spring gap",
    start: "2030-03-10T06:30:00Z",
    end: "2030-03-10T07:30:00Z",
    zone: "America/New_York",
    milliseconds: 3_600_000,
    want: "1 hour",
  },
  {
    name: "New York repeated hour",
    start: "2030-11-03T05:30:00Z",
    end: "2030-11-03T06:30:00Z",
    zone: "America/New_York",
    milliseconds: 3_600_000,
    want: "1 hour",
  },
  {
    name: "sub-minute",
    start: "2030-06-01T18:00:00Z",
    end: "2030-06-01T18:00:59.999Z",
    zone: "UTC",
    milliseconds: 59_999,
    want: "Less than a minute",
  },
  {
    name: "one minute",
    start: "2030-06-01T18:00:00Z",
    end: "2030-06-01T18:01:00Z",
    zone: "UTC",
    milliseconds: 60_000,
    want: "1 minute",
  },
  {
    name: "whole hours",
    start: "2030-06-01T18:00:00Z",
    end: "2030-06-01T20:00:00Z",
    zone: "UTC",
    milliseconds: 7_200_000,
    want: "2 hours",
  },
  {
    name: "invalid host zone",
    start: "2030-06-01T18:00:00Z",
    end: "2030-06-01T19:30:00Z",
    zone: "Invalid/Timezone",
    milliseconds: 5_400_000,
    want: "1 hour 30 minutes",
  },
];

export function durationEvent(fixture: (typeof durationCases)[number]) {
  return scheduledEvent(scheduleCases[0], {
    startsAt: new Date(fixture.start),
    endsAt: new Date(fixture.end),
    timezone: fixture.zone,
  });
}

export const clockTitle = "Community chess gathering with friends from across the world";
export const clockCases = [
  {
    name: "London",
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    zone: "Europe/London",
    effective: "Europe/London",
    clock: "19:00",
    title: clockTitle,
    status: "published",
  },
  {
    name: "New York",
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    zone: "America/New_York",
    effective: "America/New_York",
    clock: "14:00",
    title: "New York chess",
    status: "published",
  },
  {
    name: "invalid zone",
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
    zone: "Invalid/Timezone",
    effective: "UTC",
    clock: "18:00",
    title: "Fallback chess",
    status: "published",
  },
  {
    name: "cancelled long title",
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
    zone: "Europe/London",
    effective: "Europe/London",
    clock: "19:00",
    title: `Cancelled ${clockTitle}`,
    status: "cancelled",
  },
] as const;

export function clockRows(): CalendarRow[] {
  const rows = clockCases.map((fixture, i) =>
    gathering({
      id: i + 1,
      eventKey: fixture.eventKey,
      title: fixture.title,
      timezone: fixture.zone,
      status: fixture.status,
      startsAt: new Date("2030-06-01T18:00:00Z"),
      endsAt: new Date("2030-06-02T06:00:00Z"),
    }),
  );
  const transient: DiscordTransient = {
    discordId: "fixture-discord",
    status: "scheduled",
    title: "Discord transient chess",
    description: null,
    location: null,
    startsAt: new Date("2030-06-01T18:00:00Z"),
    endsAt: null,
  };
  return [...rows, transient];
}
