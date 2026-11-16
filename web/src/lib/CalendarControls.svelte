<script lang="ts">
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
} from "../../../src/islands/contracts";
import { feedUrl, webcalUrl } from "../../../src/events/feeds";
import { SUBSCRIPTION_GUIDANCE } from "../../../src/events/subscription-copy";
import SegmentedControl from "./SegmentedControl.svelte";

let { state, appUrl, games, gameFilter, searching, pastCount, emptyState, hasVisibleResults, outOfRange }: {
  state: CalendarState;
  appUrl: string;
  games: string[];
  gameFilter: string | null;
  searching: boolean;
  pastCount: number;
  emptyState: CalendarEmptyState;
  hasVisibleResults: boolean;
  outOfRange: boolean;
} = $props();

let url = $derived(feedUrl(appUrl, gameFilter));
let searchStatus = $derived(
  searching && emptyState !== "error"
    ? hasVisibleResults || outOfRange
      ? gameFilter !== null ? eventsSearchGameHitCopy(state.q, gameFilter) : eventsSearchHitCopy(state.q)
      : gameFilter !== null ? eventsSearchGameMissCopy(state.q, gameFilter) : eventsSearchMissCopy(state.q)
    : gameFilter !== null && emptyState !== "error" ? eventsGameFilterCopy(gameFilter) : "",
);
</script>

<p role="status" class="sr-only" data-testid={EVENTS_VIEW_STATUS_TESTID}>{eventsViewStatusCopy(state.view)}</p>
<p role="status" class="sr-only" data-testid={EVENTS_SEARCH_STATUS_TESTID}>{searchStatus}</p>
<p role="status" class="sr-only" data-testid={EVENTS_PAST_STATUS_TESTID}>{state.past && pastCount > 0 ? EVENTS_PAST_STATUS_COPY : ""}</p>
<p role="status" class="sr-only" data-testid={CALENDAR_MONTH_STATUS_TESTID}>{state.view === "calendar" ? calendarMonthLabel(state.month) : ""}</p>

<div data-cal-zone="head">
  <SegmentedControl label={EVENTS_VIEW_GROUP_LABEL} items={[
    { href: calendarUrl({ ...state, view: "list" }), label: "List", current: state.view === "list", testId: EVENTS_VIEW_LIST_TESTID },
    { href: calendarUrl({ ...state, view: "calendar" }), label: "Calendar", current: state.view === "calendar", testId: EVENTS_VIEW_CALENDAR_TESTID },
  ]} />
  <p>
    <a href={pastEventsUrl(1, state.q)} data-testid={EVENTS_PAST_ARCHIVE_LINK_TESTID}>{state.q ? "Continue search in past events" : EVENTS_EMPTY_COPY.pastArchive}</a>{" "}
    <a href={webcalUrl(appUrl, gameFilter)} data-testid={EVENTS_SUBSCRIBE_TESTID}>{EVENTS_EMPTY_COPY.subscribe}</a>{" "}
    <a href="/events.rss">RSS feed</a>{" "}
    <a href={url}>Download calendar (.ics)</a>{" "}
    <a href="/hotzones">Hot zones</a>
  </p>
</div>
<details class="subscription-help" data-testid="subscription-help" data-cal-zone="subscribe">
  <summary>How to subscribe to the calendar</summary>
  {#each SUBSCRIPTION_GUIDANCE.slice(0, 2) as paragraph}<p>{paragraph}</p>{/each}
  <label for="calendar-feed-url">{gameFilter === null ? "Calendar feed URL" : `${gameFilter} calendar feed URL`}</label>
  <div class="subscription-copy">
    <input id="calendar-feed-url" data-testid="subscription-feed-url" type="text" value={url} readonly />
    <button class="btn" type="button" data-testid="subscription-copy-button" data-copy-link={url} data-copy-feed hidden>Copy feed URL</button>
  </div>
  <p data-testid="subscription-manual-copy">Select the feed URL and copy it manually in your calendar app.</p>
  <p role="status" aria-atomic="true" data-copy-toast data-testid="subscription-copy-status"></p>
  <p>{SUBSCRIPTION_GUIDANCE[2]}</p>
</details>

<form method="get" action="/events" role="search">
  <label class="sr-only" for="events-search-input">{EVENTS_SEARCH_LABEL}</label>
  <input id="events-search-input" type="search" name="q" value={state.q} placeholder={EVENTS_SEARCH_PLACEHOLDER} aria-label={EVENTS_SEARCH_LABEL} aria-describedby="events-search-scope" data-testid={EVENTS_SEARCH_TESTID} />
  <span class="schedule-game-filter">
    <label for="events-game-filter">{EVENTS_GAME_FILTER_LABEL}</label>
    <select id="events-game-filter" name="game" data-testid={EVENTS_GAME_FILTER_TESTID}>
      <option value="" selected={gameFilter === null}>{EVENTS_GAME_ALL_COPY}</option>
      {#each games as game}<option value={game} selected={game === gameFilter}>{game}</option>{/each}
    </select>
  </span>
  <button class="btn" type="submit">Search</button>
  <span data-cal-zone="actions">
    {#if state.past}<input type="hidden" name="past" value="1" />{/if}
    {#if searching}<a href={calendarUrl({ ...state, q: "" })} data-testid={EVENTS_SEARCH_CLEAR_TESTID}>{EVENTS_EMPTY_COPY.searchClear}</a>{/if}
  </span>
  <p id="events-search-scope">Searches event titles and descriptions.</p>
</form>
