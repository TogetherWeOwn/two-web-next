// Events calendar screen: composes the controls, empty states, list and month grid.
import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import {
  EVENTS_CAL_FEEDBACK,
  EVENTS_CALENDAR_FETCH_FAILED,
  EVENTS_CALENDAR_ISLAND,
  EVENTS_CALENDAR_TESTID,
  EVENTS_CONTENT_TESTID,
  EVENTS_LOADING_COPY,
  EVENTS_LOADING_ROWS,
  EVENTS_LOADING_TESTID,
  EVENTS_SEARCH_MAX_LENGTH,
  EVENTS_SEARCH_TOO_LONG_COPY,
  calendarSearching,
  calendarShowingPast,
  calendarUrl,
  monthGrid,
  wallDateIso,
  type CalendarEmptyState,
  type CalendarState,
} from "../islands/contracts";
import { JoinResultBanner } from "../pages";
import type { JoinResult } from "../return-journey";
import type { PublicEvent } from "./reads";
import { ScheduleShell } from "./pages-shared";
import { CalendarHead, CalendarLiveRegions, CalendarSearchForm } from "./pages-calendar-controls";
import {
  EmptyError,
  EmptyGap,
  EmptyNever,
  PartialSourceNotice,
  SearchMiss,
} from "./pages-calendar-empty";
import { MonthGrid } from "./pages-calendar-grid";
import { CalendarList } from "./pages-calendar-list";
import { type CalRow, rowZone } from "./pages-calendar-row";

/**
 * The events calendar island (legacy Livewire EventsCalendar): one rowset
 * rendered as list or month grid, every control a real anchor so the page is
 * fully functional without JavaScript; the binder upgrades anchors to
 * fragment swaps. Zones: `head` (toggle + links), `actions` (Clear control),
 * `miss` (search-miss block), `content` (empty states / list / grid). Live-status
 * lines, the search input, skeleton and feedback stay outside swapped zones —
 * the input must never be re-created mid-typing.
 */
export const EventsCalendarPage: FC<{
  state: CalendarState;
  upcoming: CalRow[];
  past: PublicEvent[];
  zone: string;
  now: Date;
  /** Upcoming-list pages; the month grid is month-scoped and ignores it. */
  totalPages: number;
  emptyState: CalendarEmptyState;
  discordFailed: boolean;
  member: boolean;
  inviteUrl: string;
  appUrl: string;
  /** Rooted path the guest sign-in link carries as ?next= (null = bare link). */
  loginReturnTo?: string | null;
  /** In-body robots directive (survives the anonymous shared entry, where the
      response header is dropped on a cache hit): set for paged turns, card
      jumps and searches, like the past archive's always-noindex pages. */
  robots?: string;
  /** One-shot join confirmation when this page is the join landing (TOG-10356). */
  joinResult?: JoinResult | null;
  /** Rooted .md alternate path (A2); omitted where no alternate exists (past archive). */
  markdownAlternate?: string | null;
}> = ({
  state,
  upcoming,
  past,
  zone,
  now,
  totalPages,
  emptyState,
  discordFailed,
  member,
  inviteUrl,
  appUrl,
  loginReturnTo = null,
  robots,
  joinResult = null,
  markdownAlternate = null,
}) => {
  const searching = calendarSearching(state);
  const showPast = calendarShowingPast(state);
  const hasVisibleResults = upcoming.length > 0 || (showPast && past.length > 0);
  // A page past the end renders an out-of-range note with turns back into the
  // schedule — like the past archive — never a "never scheduled" state and
  // never a search miss for matches sitting on another page.
  const outOfRange = state.view === "list" && upcoming.length === 0 && totalPages > 0;
  // An error state suppresses the miss block: a failed read must never read
  // as "no matches" (contract: error beats everything, including a search).
  const searchMiss = searching && !hasVisibleResults && emptyState === null && !outOfRange;
  const url = calendarUrl(state);
  const byDay = new Map<string, CalRow[]>();
  for (const e of [...upcoming, ...(showPast ? past : [])]) {
    const key = wallDateIso(e.startsAt, rowZone(e, zone));
    const list = byDay.get(key) ?? [];
    list.push(e);
    byDay.set(key, list);
  }
  const weeks = monthGrid(state.month, wallDateIso(now, zone), byDay);
  return (
    <ScheduleShell
      title="Events"
      canonical={canonicalUrl(appUrl, "/events")}
      description="Game nights, tournaments and whatever else the community puts on."
      robots={robots}
      member={member}
      loginReturnTo={loginReturnTo}
      markdownAlternate={markdownAlternate ?? undefined}
    >
      <section
        data-island={EVENTS_CALENDAR_ISLAND}
        data-testid={EVENTS_CALENDAR_TESTID}
        data-view={state.view}
        data-month={state.month}
        data-past={state.past ? "1" : ""}
        data-load-error={EVENTS_CALENDAR_FETCH_FAILED}
        data-search-max-length={EVENTS_SEARCH_MAX_LENGTH}
        data-search-too-long={EVENTS_SEARCH_TOO_LONG_COPY}
        aria-labelledby="events-heading"
      >
        <div class="schedule-heading">
          <p class="strap">Community schedule</p>
          <h1 id="events-heading" tabindex={-1}>
            Events
          </h1>
          <p>Game nights, tournaments and whatever else the community puts on.</p>
          {!member ? (
            <a
              class="btn"
              href={loginReturnTo ? `/join?next=${encodeURIComponent(loginReturnTo)}` : "/join"}
            >
              Join the Discord
            </a>
          ) : null}
        </div>
        {/* One-shot join confirmation (legacy join_result): /events is the
            join landing when the CTA carried next=/events. Renders outside the
            island zones so fragment swaps never swallow it. */}
        {joinResult ? <JoinResultBanner result={joinResult} /> : null}

        <CalendarLiveRegions
          state={state}
          pastCount={past.length}
          searching={searching}
          emptyState={emptyState}
          hasVisibleResults={hasVisibleResults}
          outOfRange={outOfRange}
        />

        <CalendarHead state={state} appUrl={appUrl} />

        <CalendarSearchForm state={state} searching={searching} />

        {/* Beside the search box, so the over-limit notice shows where the query is typed. */}
        <p role="status" {...{ [EVENTS_CAL_FEEDBACK]: true }} />

        <div data-cal-zone="miss">{searchMiss ? <SearchMiss state={state} /> : null}</div>

        {/* Skeleton: member-started re-renders only — typing is untargeted. */}
        <div data-testid={EVENTS_LOADING_TESTID} hidden>
          <p>{EVENTS_LOADING_COPY}</p>
          {Array.from({ length: EVENTS_LOADING_ROWS }, () => (
            <p aria-hidden="true">…</p>
          ))}
        </div>

        <div data-cal-zone="content" data-testid={EVENTS_CONTENT_TESTID}>
          {/* Partial source: healthy rows stay useful beside the notice. An
              empty state (including the failed-empty error) takes precedence,
              and an out-of-range page keeps its turns back into the schedule.
              The month grid renders whenever there is no empty state, so an
              empty month of a non-empty schedule carries the notice too —
              without it the month would read as definitively empty. Inside
              the swapped zone so fragment turns add/remove the notice. */}
          {discordFailed &&
          emptyState === null &&
          (hasVisibleResults || outOfRange || state.view === "calendar") ? (
            <PartialSourceNotice url={url} inviteUrl={inviteUrl} />
          ) : null}

          {emptyState === "error" ? (
            <EmptyError url={url} inviteUrl={inviteUrl} />
          ) : emptyState === "never" ? (
            <EmptyNever inviteUrl={inviteUrl} />
          ) : emptyState === "gap" ? (
            <EmptyGap past={past} zone={zone} />
          ) : null}

          {emptyState === null && (hasVisibleResults || outOfRange) && state.view === "list" ? (
            <CalendarList
              state={state}
              upcoming={upcoming}
              past={past}
              zone={zone}
              totalPages={totalPages}
              outOfRange={outOfRange}
              showPast={showPast}
              member={member}
              inviteUrl={inviteUrl}
              loginReturnTo={loginReturnTo}
            />
          ) : null}

          {/* The grid is month-scoped, so its gate cannot be the rendered rows:
              an empty month of a non-empty schedule still renders the grid.
              With no empty state there is always something somewhere — the
              empty states already cover the empty collection — so their
              absence alone opens the grid, exactly like the old unpaged merge
              whose non-emptiness always implied visible rows. */}
          {emptyState === null && state.view === "calendar" ? (
            <MonthGrid state={state} weeks={weeks} zone={zone} />
          ) : null}
        </div>
      </section>
      <script src="/islands/events-calendar.js" defer />
    </ScheduleShell>
  );
};

/** No-JS over-limit search: a notice with site chrome. It never echoes the query back. */
export const EventsSearchTooLongPage: FC<{ appUrl: string }> = ({ appUrl }) => (
  <ScheduleShell
    title="Events"
    canonical={canonicalUrl(appUrl, "/events")}
    robots="noindex, follow"
  >
    <div class="schedule-heading">
      <p class="strap">Community schedule</p>
      <h1>Events</h1>
    </div>
    <p role="alert">{EVENTS_SEARCH_TOO_LONG_COPY}</p>
    <p>
      <a href="/events">Back to events</a>
    </p>
  </ScheduleShell>
);
