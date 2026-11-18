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
  wallMonth,
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
  searchMiss: boolean;
  weeks: CalendarDay<CalRow>[][];
  monthEmpty: boolean;
}

export function deriveCalendarScreenState({
  state,
  upcoming,
  past,
  pastMayBeTruncated = past.length >= EVENTS_PAST_DRAWER_LIMIT,
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
  // A page past the end renders an out-of-range note with turns back into the
  // schedule — like the past archive — never a "never scheduled" state and
  // never a search miss for matches sitting on another page.
  const outOfRange = state.view === "list" && upcoming.length === 0 && totalPages > 0;
  // An error state suppresses the miss block: a failed read must never read
  // as "no matches" (contract: error beats everything, including a search).
  const searchMiss =
    emptyState === null &&
    !discordFailed &&
    !outOfRange &&
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
  // Month-local emptiness follows occupied in-month cells, including canonical
  // continuations, but never spillover cells. Count past start-days even with
  // the drawer closed: the claim names the month, not just the visible rows.
  // A truncated past drawer (at the cap) leaves months at or before the wall month
  // incomplete — older in-month past rows may exist unread — so the claim is
  // suppressed there; future months cannot hold past rows. A failed source
  // suppresses the claim — October may only look empty — while the
  // error/never/gap states keep their own precedence. A game-scoped miss
  // already names the effective scope with its own broadening link, so it
  // suppresses the unscoped month sentence: with game-filtered grid rows the
  // sentence is false when another game occupies the month, and its
  // Upcoming-events link would land back on the same filtered zero.
  const monthHasInMonthRows =
    weeks.some((week) => week.some((day) => day.inMonth && day.events.length > 0)) ||
    past.some((e) => wallDateIso(e.startsAt, rowZone(e, zone)).startsWith(`${state.month}-`));
  const monthCouldHoldPast = state.month <= wallMonth(now, zone);
  const monthEmpty =
    emptyState === null &&
    state.view === "calendar" &&
    !discordFailed &&
    !monthHasInMonthRows &&
    !(pastMayBeTruncated && monthCouldHoldPast) &&
    !searchMiss;
  return { searching, showPast, hasVisibleResults, outOfRange, searchMiss, weeks, monthEmpty };
}
