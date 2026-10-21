// Literal endpoint expectations, independent of the production date formatter.
export const scheduleCases = [
  {
    name: "same day",
    timezone: "America/New_York",
    label: "America/New_York",
    startsAt: "2026-06-20T16:30:00.000Z",
    endsAt: "2026-06-20T18:00:00.000Z",
    start: { day: "20", month: "Jun", year: "2026", clock: "12:30", offset: "GMT-04:00" },
    end: { day: "20", month: "Jun", year: "2026", clock: "14:00", offset: "GMT-04:00" },
  },
  {
    name: "overnight",
    timezone: "America/New_York",
    label: "America/New_York",
    startsAt: "2026-06-21T03:30:00.000Z",
    endsAt: "2026-06-21T05:15:00.000Z",
    start: { day: "20", month: "Jun", year: "2026", clock: "23:30", offset: "GMT-04:00" },
    end: { day: "21", month: "Jun", year: "2026", clock: "01:15", offset: "GMT-04:00" },
  },
  {
    name: "multi-day",
    timezone: "America/New_York",
    label: "America/New_York",
    startsAt: "2026-08-28T13:00:00.000Z",
    endsAt: "2026-08-30T21:45:00.000Z",
    start: { day: "28", month: "Aug", year: "2026", clock: "09:00", offset: "GMT-04:00" },
    end: { day: "30", month: "Aug", year: "2026", clock: "17:45", offset: "GMT-04:00" },
  },
  {
    name: "year crossing",
    timezone: "America/New_York",
    label: "America/New_York",
    startsAt: "2027-01-01T04:30:00.000Z",
    endsAt: "2027-01-01T06:15:00.000Z",
    start: { day: "31", month: "Dec", year: "2026", clock: "23:30", offset: "GMT-05:00" },
    end: { day: "1", month: "Jan", year: "2027", clock: "01:15", offset: "GMT-05:00" },
  },
  {
    name: "spring DST gap",
    timezone: "America/New_York",
    label: "America/New_York",
    startsAt: "2026-03-08T06:30:00.000Z",
    endsAt: "2026-03-08T07:30:00.000Z",
    start: { day: "8", month: "Mar", year: "2026", clock: "01:30", offset: "GMT-05:00" },
    end: { day: "8", month: "Mar", year: "2026", clock: "03:30", offset: "GMT-04:00" },
  },
  {
    name: "autumn DST repeated hour",
    timezone: "America/New_York",
    label: "America/New_York",
    startsAt: "2026-11-01T05:30:00.000Z",
    endsAt: "2026-11-01T06:30:00.000Z",
    start: { day: "1", month: "Nov", year: "2026", clock: "01:30", offset: "GMT-04:00" },
    end: { day: "1", month: "Nov", year: "2026", clock: "01:30", offset: "GMT-05:00" },
  },
  {
    name: "invalid zone falls back across midnight",
    timezone: "Invalid/Timezone",
    label: "UTC",
    startsAt: "2026-06-20T16:30:00.000Z",
    endsAt: "2026-06-21T00:15:00.000Z",
    start: { day: "20", month: "Jun", year: "2026", clock: "16:30", offset: "GMT+00:00" },
    end: { day: "21", month: "Jun", year: "2026", clock: "00:15", offset: "GMT+00:00" },
  },
] as const;

export type ScheduleCase = (typeof scheduleCases)[number];
export const scheduleNow = new Date("2026-01-01T00:00:00.000Z");
