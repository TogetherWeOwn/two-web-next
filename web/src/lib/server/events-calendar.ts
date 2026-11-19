import { deriveCalendarScreenState } from "../../../../src/events/calendar-screen-state";
import { effectiveZone } from "../../../../src/events/date-format";
import {
  type CalRow,
  isTransient,
  rowAvailability,
  rowKey,
  rowZone,
} from "../../../../src/events/pages-calendar-row";
import type { PublicEvent } from "../../../../src/events/reads";
import { searchContext } from "../../../../src/events/search-context";
import { matchQuery } from "../../../../src/events/search-query";
import { EVENTS_GAP_LIST_LIMIT, wallMonth } from "../../../../src/islands/contracts";
import type { KitEventsLoadData } from "../../../../src/kit-events";
import type { CalendarGridEntry } from "../calendar-grid";
import type { CalendarListCard, CalendarPersistedCard } from "../calendar-list";

function cardFields(e: CalRow, zone: string, now: Date, query: string, past: boolean) {
  return {
    key: rowKey(e),
    title: e.title,
    titleSegments: query ? searchContext(e.title, query) : null,
    zone: rowZone(e, zone),
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    location: e.location,
    description: e.description,
    passage: query ? searchContext(e.description ?? "", query, true) : null,
    availability: rowAvailability(e, now, past),
  };
}

function persistedCard(
  e: PublicEvent,
  fields: ReturnType<typeof cardFields>,
): CalendarPersistedCard {
  return {
    ...fields,
    kind: "event",
    eventKey: e.eventKey,
    status:
      e.status === "draft" || e.status === "cancelled" || e.status === "past"
        ? e.status
        : "published",
    game: e.game,
    host: (e.organizer_name ?? "").trim(),
    goingCount: e.goingCount,
    goingOccupancy: e.goingOccupancy,
    capacity: e.capacity,
  };
}

/** Allowlist the calendar body inputs; never give the component DB rows or viewer credentials. */
export function projectEventsCalendar(data: KitEventsLoadData) {
  const { state, zone, now } = data;
  const { weeks, showPast, hasVisibleResults, outOfRange, pageUnreadable, searchMiss, monthEmpty } =
    deriveCalendarScreenState(data);
  const query = matchQuery(state.q) ?? "";
  const currentMonth = wallMonth(now, zone);
  return {
    state,
    appUrl: data.appUrl,
    games: data.games,
    gameFilter: data.gameFilter,
    totalPages: data.totalPages,
    emptyState: data.emptyState,
    discordFailed: data.discordFailed,
    inviteUrl: data.inviteUrl,
    member: data.member,
    loginReturnTo: data.loginReturnTo,
    showPast,
    hasVisibleResults,
    outOfRange,
    pageUnreadable,
    searchMiss,
    monthEmpty,
    zone,
    now,
    upcoming: data.upcoming.map((e): CalendarListCard => {
      const fields = cardFields(e, zone, now, query, false);
      return isTransient(e) ? { ...fields, kind: "discord" } : persistedCard(e, fields);
    }),
    past: data.past.map((e) => persistedCard(e, cardFields(e, zone, now, "", true))),
    gapPast: data.past.slice(0, EVENTS_GAP_LIST_LIMIT).map((e) => ({
      eventKey: e.eventKey,
      title: e.title,
      startsAt: e.startsAt,
      timezone: effectiveZone(e.timezone),
      status: e.status,
    })),
    weeks: weeks.map((week) =>
      week.map((day) => {
        const inCurrentMonth = day.iso.slice(0, -3) === currentMonth;
        return {
          ...day,
          events: day.events.map((e): CalendarGridEntry => {
            const transient = isTransient(e);
            const availability = rowAvailability(e, now, transient && !inCurrentMonth);
            return {
              key: rowKey(e),
              title: e.title,
              startsAt: e.startsAt,
              zone: rowZone(e, zone),
              cancelled: !transient && e.status === "cancelled",
              availability: availability?.text ?? null,
              ongoing: inCurrentMonth && (availability?.ongoing ?? false),
            };
          }),
        };
      }),
    ),
  };
}
