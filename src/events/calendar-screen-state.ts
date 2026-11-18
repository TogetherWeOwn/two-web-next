// Framework-neutral derived display state for the events calendar screen.
// Pure: no JSX, no I/O. The Hono screen consumes it today; a SvelteKit list
// can call the same function so both render from one set of rules.
import {
  EVENTS_PAST_DRAWER_LIMIT,
  calendarGridRange,
  calendarSearching,
  calendarShowingPast,
  canonicalIntervalDays,
  monthGrid,
  wallDateIso,
  wallDayStart,
  type CalendarDay,
  type CalendarEmptyState,
  type CalendarState,
} from "../islands/contracts";
import { type CalRow, isTransient, rowZone } from "./pages-calendar-row";
import type { PublicEvent } from "./reads";

export interface CalendarScreenStateInput {
  state: CalendarState;
  upcoming: CalRow[];
  past: PublicEvent[];
  pastMayBeTruncated?: boolean;
  monthReadMayBeIncomplete?: boolean;
  zone: string;
  now: Date;
  totalPages: number;
  emptyState: CalendarEmptyState;
  discordFailed: boolean;
  gameFilter: string | null;
}

export interface CalendarScreenState {
  searching: boolean;
  showPast: boolean;
  hasVisibleResults: boolean;
  outOfRange: boolean;
  pageUnreadable: boolean;
  searchMiss: boolean;
  weeks: CalendarDay<CalRow>[][];
  monthEmpty: boolean;
}

export function deriveCalendarScreenState({
  state,
  upcoming,
  past,
  pastMayBeTruncated = past.length >= EVENTS_PAST_DRAWER_LIMIT,
  monthReadMayBeIncomplete = false,
  zone,
  now,
  totalPages,
  emptyState,
  discordFailed,
  gameFilter,
}: CalendarScreenStateInput): CalendarScreenState {
  const searching = calendarSearching(state);
  const showPast = calendarShowingPast(state);
  const hasVisibleResults = upcoming.length > 0 || (showPast && past.length > 0);
  // An empty list page with counted results isn't a search miss. If it is
  // in range, the notice says it can't be shown, not why it has no cards.
  const emptyCountedPage = state.view === "list" && totalPages > 0 && upcoming.length === 0;
  const outOfRange = emptyCountedPage && state.page > totalPages;
  const pageUnreadable = emptyCountedPage && !outOfRange;
  const searchMiss =
    emptyState === null &&
    !discordFailed &&
    !emptyCountedPage &&
    ((searching && !hasVisibleResults) ||
      (!searching && gameFilter !== null && upcoming.length === 0 && totalPages === 0));
  const byDay = new Map<string, CalRow[]>();
  const pushDay = (day: string, e: CalRow) => {
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  };
  // Canonical upcoming rows occupy every host-zone day their finite interval
  // touches, clipped to the grid before iteration; transients and past rows
  // keep start-day-only plotting.
  const gridRange = calendarGridRange(state.month);
  for (const e of upcoming) {
    if (!isTransient(e) && gridRange) {
      for (const day of canonicalIntervalDays(
        e.startsAt,
        e.endsAt,
        e.timezone,
        gridRange.first,
        gridRange.last,
      )) {
        pushDay(day, e);
      }
    } else {
      pushDay(wallDateIso(e.startsAt, rowZone(e, zone)), e);
    }
  }
  if (showPast) {
    for (const e of past) {
      pushDay(wallDateIso(e.startsAt, rowZone(e, zone)), e);
    }
  }
  const weeks = monthGrid(state.month, wallDateIso(now, zone), byDay);
  // Count occupied in-month days, including continuations and past start-days
  // behind a closed drawer, but never days in the adjacent months.
  const monthHasInMonthRows =
    weeks.some((week) => week.some((day) => day.inMonth && day.events.length > 0)) ||
    past.some((e) => wallDateIso(e.startsAt, rowZone(e, zone)).startsWith(`${state.month}-`));
  // The past read sorts UTC starts descending, so every retained start bounds
  // omitted starts. Allow a full day for a host zone ahead of UTC; the grid's
  // modal zone cannot bound the wall date of an unseen row.
  const monthStart = wallDayStart(`${state.month}-01`);
  const pastCouldBeMissingInMonth =
    pastMayBeTruncated && !past.some((e) => e.startsAt.getTime() + 86_400_000 < monthStart);
  const monthEmpty =
    emptyState === null &&
    state.view === "calendar" &&
    !discordFailed &&
    !monthHasInMonthRows &&
    !monthReadMayBeIncomplete &&
    !pastCouldBeMissingInMonth &&
    !searchMiss;
  return {
    searching,
    showPast,
    hasVisibleResults,
    outOfRange,
    pageUnreadable,
    searchMiss,
    weeks,
    monthEmpty,
  };
}
