import type { CalendarDay, CalendarState } from "../../../src/islands/contracts";

/** Public presentation data only; callers project rows and decide availability. */
export interface CalendarGridEntry {
  key: string;
  title: string;
  startsAt: Date;
  /** Effective event time zone, or an invalid zone to fall back to UTC. */
  zone: string;
  cancelled: boolean;
  ongoing: boolean;
  availability: string | null;
}

/** Whole Monday-first weeks, prepared in the calendar's display zone. */
export interface CalendarGridProps {
  state: CalendarState;
  weeks: CalendarDay<CalendarGridEntry>[][];
  zone: string;
  /** Server snapshot used for the This month link. */
  now: Date;
}
