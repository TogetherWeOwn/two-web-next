// Calendar controls: live-status lines, the view toggle + archive/feed links,
// and the search form.
import type { FC } from "hono/jsx";
import {
  CALENDAR_MONTH_STATUS_TESTID,
  EVENTS_EMPTY_COPY,
  EVENTS_GAME_ALL_COPY,
  EVENTS_GAME_FILTER_LABEL,
  EVENTS_GAME_FILTER_TESTID,
  EVENTS_PAST_ARCHIVE_LINK_TESTID,
  EVENTS_PAST_STATUS_COPY,
  EVENTS_PAST_STATUS_TESTID,
  EVENTS_SEARCH_CLEAR_TESTID,
  EVENTS_SEARCH_LABEL,
  EVENTS_SEARCH_PLACEHOLDER,
  EVENTS_SEARCH_STATUS_TESTID,
  EVENTS_SEARCH_TESTID,
  EVENTS_SUBSCRIBE_TESTID,
  EVENTS_VIEW_CALENDAR_TESTID,
  EVENTS_VIEW_GROUP_LABEL,
  EVENTS_VIEW_LIST_TESTID,
  EVENTS_VIEW_STATUS_TESTID,
  calendarMonthLabel,
  calendarUrl,
  eventsGameFilterCopy,
  eventsSearchGameHitCopy,
  eventsSearchGameMissCopy,
  eventsSearchHitCopy,
  eventsSearchMissCopy,
  eventsViewStatusCopy,
  pastEventsUrl,
  type CalendarEmptyState,
  type CalendarState,
} from "../islands/contracts";
import { feedUrl, webcalUrl } from "./feeds";
import { subscriptionHelp } from "./subscription-help";

/**
 * Live regions OUTSIDE the swapped zones (legacy TOG-5416): they must
 * announce without being re-created.
 */
export const CalendarLiveRegions: FC<{
  state: CalendarState;
  pastCount: number;
  searching: boolean;
  emptyState: CalendarEmptyState;
  hasVisibleResults: boolean;
  outOfRange: boolean;
  gameFilter: string | null;
}> = ({ state, pastCount, searching, emptyState, hasVisibleResults, outOfRange, gameFilter }) => (
  <>
    <p role="status" class="sr-only" data-testid={EVENTS_VIEW_STATUS_TESTID}>
      {eventsViewStatusCopy(state.view)}
    </p>
    {/* An out-of-range search page still announces a hit: its matches sit
        on another page, so "nothing matches" would be wrong and the miss
        block stays hidden for the same reason (see searchMiss in the screen).
        A game facet announces alongside the search (or alone); a failed read
        stays silent either way. */}
    <p role="status" class="sr-only" data-testid={EVENTS_SEARCH_STATUS_TESTID}>
      {searching && emptyState !== "error"
        ? hasVisibleResults || outOfRange
          ? gameFilter !== null
            ? eventsSearchGameHitCopy(state.q, gameFilter)
            : eventsSearchHitCopy(state.q)
          : gameFilter !== null
            ? eventsSearchGameMissCopy(state.q, gameFilter)
            : eventsSearchMissCopy(state.q)
        : gameFilter !== null && emptyState !== "error"
          ? eventsGameFilterCopy(gameFilter)
          : ""}
    </p>
    <p role="status" class="sr-only" data-testid={EVENTS_PAST_STATUS_TESTID}>
      {state.past && pastCount > 0 ? EVENTS_PAST_STATUS_COPY : ""}
    </p>
    <p role="status" class="sr-only" data-testid={CALENDAR_MONTH_STATUS_TESTID}>
      {state.view === "calendar" ? calendarMonthLabel(state.month) : ""}
    </p>
  </>
);

/** The `head` zone: list/calendar toggle plus the archive, subscribe and feed links. */
export const CalendarHead: FC<{ state: CalendarState; appUrl: string }> = ({ state, appUrl }) => (
  <>
    <div data-cal-zone="head">
      <div class="schedule-views" role="group" aria-label={EVENTS_VIEW_GROUP_LABEL}>
        <a
          href={calendarUrl({ ...state, view: "list" })}
          aria-current={state.view === "list" ? "page" : undefined}
          data-testid={EVENTS_VIEW_LIST_TESTID}
        >
          List
        </a>{" "}
        <a
          href={calendarUrl({ ...state, view: "calendar" })}
          aria-current={state.view === "calendar" ? "page" : undefined}
          data-testid={EVENTS_VIEW_CALENDAR_TESTID}
        >
          Calendar
        </a>
      </div>
      <p>
        <a
          href={pastEventsUrl(1, state.q, state.game ?? "")}
          data-testid={EVENTS_PAST_ARCHIVE_LINK_TESTID}
        >
          {state.q ? "Continue search in past events" : EVENTS_EMPTY_COPY.pastArchive}
        </a>{" "}
        <a href={webcalUrl(appUrl)} data-testid={EVENTS_SUBSCRIBE_TESTID}>
          {EVENTS_EMPTY_COPY.subscribe}
        </a>{" "}
        <a href={feedUrl(appUrl)}>Download calendar (.ics)</a> <a href="/events.rss">RSS feed</a>
      </p>
    </div>
    {subscriptionHelp(appUrl)}
  </>
);

/** The form is stable: the binder debounces input and never swaps it. The game
 * facet is a plain select in the same GET form, so keyboard and no-JS
 * filtering work through the submit button like the text search. */
export const CalendarSearchForm: FC<{
  state: CalendarState;
  searching: boolean;
  games: string[];
  gameFilter: string | null;
}> = ({ state, searching, games, gameFilter }) => (
  <form method="get" action="/events" role="search">
    <label class="sr-only" for="events-search-input">
      {EVENTS_SEARCH_LABEL}
    </label>
    {/* Native maxlength counts UTF-16 units; code-point limits belong to the validators. */}
    <input
      id="events-search-input"
      type="search"
      name="q"
      value={state.q}
      placeholder={EVENTS_SEARCH_PLACEHOLDER}
      aria-label={EVENTS_SEARCH_LABEL}
      aria-describedby="events-search-scope"
      data-testid={EVENTS_SEARCH_TESTID}
    />
    <span class="schedule-game-filter">
      <label for="events-game-filter">{EVENTS_GAME_FILTER_LABEL}</label>
      <select id="events-game-filter" name="game" data-testid={EVENTS_GAME_FILTER_TESTID}>
        <option value="" selected={gameFilter === null}>
          {EVENTS_GAME_ALL_COPY}
        </option>
        {games.map((game) => (
          <option value={game} selected={game === gameFilter}>
            {game}
          </option>
        ))}
      </select>
    </span>
    <button class="btn" type="submit">
      Search
    </button>
    <span data-cal-zone="actions">
      {state.past ? <input type="hidden" name="past" value="1" /> : null}
      {searching ? (
        <a href={calendarUrl({ ...state, q: "" })} data-testid={EVENTS_SEARCH_CLEAR_TESTID}>
          {EVENTS_EMPTY_COPY.searchClear}
        </a>
      ) : null}
    </span>
    {/* Persistent visible scope hint: the input is never swapped, so this
        association survives every fragment turn and calendar state. */}
    <p id="events-search-scope">Searches event titles and descriptions.</p>
  </form>
);
