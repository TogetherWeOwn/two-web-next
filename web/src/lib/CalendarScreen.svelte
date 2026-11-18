<script lang="ts">
import {
  CALENDAR_MONTH_EMPTY_RECOVERY_COPY,
  CALENDAR_MONTH_EMPTY_TESTID,
  EVENTS_CAL_FEEDBACK,
  EVENTS_CALENDAR_FETCH_FAILED,
  EVENTS_CALENDAR_ISLAND,
  EVENTS_CALENDAR_TESTID,
  EVENTS_CONTENT_TESTID,
  EVENTS_LOADING_COPY,
  EVENTS_LOADING_ROWS,
  EVENTS_LOADING_TESTID,
  EVENTS_READ_CLEAR_COPY,
  EVENTS_READ_CLEAR_TESTID,
  EVENTS_READ_RETRY_COPY,
  EVENTS_READ_RETRY_TESTID,
  EVENTS_READ_STATUS_TESTID,
  EVENTS_SEARCH_MAX_LENGTH,
  EVENTS_SEARCH_TOO_LONG_COPY,
  calendarMonthEmptyCopy,
  calendarSearching,
  calendarUrl,
  type CalendarEmptyState,
  type CalendarState,
} from "../../../src/islands/contracts";
import { HOME_JOIN_RESULT_COPY } from "../../../src/home-copy";
import type { JoinResult } from "../../../src/return-journey";
import type { CalendarGridProps } from "./calendar-grid";
import type { CalendarListCard, CalendarPersistedCard } from "./calendar-list";
import CalendarControls from "./CalendarControls.svelte";
import CalendarEmpty from "./CalendarEmpty.svelte";
import CalendarGrid from "./CalendarGrid.svelte";
import CalendarList from "./CalendarList.svelte";
import CalendarPastDrawer from "./CalendarPastDrawer.svelte";

// The caller supplies public, already-filtered presentation data and computes
// the empty/miss/month flags using the same snapshot as the rows and grid.
// gapPast is a public preview with each event's effective display timezone;
// past and upcoming follow the separately projected calendar-list contracts.
let {
  state,
  appUrl,
  games,
  gameFilter,
  past,
  gapPast,
  upcoming,
  totalPages,
  showPast,
  emptyState,
  discordFailed,
  hasVisibleResults,
  outOfRange,
  searchMiss,
  monthEmpty,
  inviteUrl,
  member,
  loginReturnTo = null,
  joinResult = null,
  weeks,
  zone,
  now,
}: {
  state: CalendarState;
  appUrl: string;
  games: string[];
  gameFilter: string | null;
  past: CalendarPersistedCard[];
  gapPast: { eventKey: string; title: string; startsAt: Date; timezone: string; status: string }[];
  upcoming: CalendarListCard[];
  totalPages: number;
  showPast: boolean;
  emptyState: CalendarEmptyState;
  discordFailed: boolean;
  hasVisibleResults: boolean;
  outOfRange: boolean;
  searchMiss: boolean;
  monthEmpty: boolean;
  inviteUrl: string;
  member: boolean;
  loginReturnTo?: string | null;
  joinResult?: JoinResult | null;
  weeks: CalendarGridProps["weeks"];
  zone: string;
  now: Date;
} = $props();
let searching = $derived(calendarSearching(state));
</script>

<section data-island={EVENTS_CALENDAR_ISLAND} data-testid={EVENTS_CALENDAR_TESTID} data-view={state.view} data-month={state.month} data-past={state.past ? "1" : ""} data-load-error={EVENTS_CALENDAR_FETCH_FAILED} data-search-max-length={EVENTS_SEARCH_MAX_LENGTH} data-search-too-long={EVENTS_SEARCH_TOO_LONG_COPY} aria-labelledby="events-heading">
  <div class="schedule-heading">
    <p class="strap">Community schedule</p>
    <h1 id="events-heading" tabindex="-1">Events</h1>
    <p>Game nights, tournaments and whatever else the community puts on.</p>
    {#if !member}<a class="btn" href={loginReturnTo ? `/join?next=${encodeURIComponent(loginReturnTo)}` : "/join"}>Join the Discord</a>{/if}
  </div>
  {#if joinResult}
    <p class="notice" role="status" data-testid="join-result">
      {#if joinResult === "added"}
        {HOME_JOIN_RESULT_COPY.added}
      {:else}
        {HOME_JOIN_RESULT_COPY.alreadyInServer}{" "}<a href="/discord" data-testid="reinvite-link">{HOME_JOIN_RESULT_COPY.reinvite}</a>
      {/if}
    </p>
  {/if}
  <CalendarControls {state} {appUrl} {games} {gameFilter} {searching} pastCount={past.length} {emptyState} {hasVisibleResults} {outOfRange} />
  <p role="status" {...{ [EVENTS_CAL_FEEDBACK]: true }}></p>
  <div>
    <p role="status" data-testid={EVENTS_READ_STATUS_TESTID}></p>
    <button type="button" class="link" data-testid={EVENTS_READ_RETRY_TESTID} hidden>{EVENTS_READ_RETRY_COPY}</button>{" "}
    <button type="button" class="link" data-testid={EVENTS_READ_CLEAR_TESTID} hidden>{EVENTS_READ_CLEAR_COPY}</button>
  </div>
  <div data-cal-zone="miss">
    {#if searchMiss}<CalendarEmpty kind="miss" {state} {gameFilter} past={gapPast} {inviteUrl} />{/if}
  </div>
  <div data-testid={EVENTS_LOADING_TESTID} hidden>
    <p>{EVENTS_LOADING_COPY}</p>
    {#each Array.from({ length: EVENTS_LOADING_ROWS }) as _}<p aria-hidden="true">…</p>{/each}
  </div>
  <div data-cal-zone="content" data-testid={EVENTS_CONTENT_TESTID}>
    {#if discordFailed && emptyState === null && (hasVisibleResults || outOfRange || state.view === "calendar")}
      <CalendarEmpty kind="partial" {state} {gameFilter} past={gapPast} {inviteUrl} />
    {/if}
    {#if emptyState !== null}<CalendarEmpty kind={emptyState} {state} {gameFilter} past={gapPast} {inviteUrl} />{/if}
    {#if emptyState === null && (hasVisibleResults || outOfRange) && state.view === "list"}
      <CalendarList {state} {upcoming} {past} {totalPages} {outOfRange} {showPast} {member} {inviteUrl} {loginReturnTo} />
    {/if}
    {#if emptyState === null && state.view === "calendar"}
      <CalendarGrid {state} {weeks} {zone} {now} />
      <CalendarPastDrawer {state} {past} {showPast} {member} {inviteUrl} {loginReturnTo} />
    {/if}
    {#if monthEmpty}
      <div data-testid={CALENDAR_MONTH_EMPTY_TESTID}>
        <p>{calendarMonthEmptyCopy(state.month)}</p>
        <p><a href={calendarUrl({ ...state, view: "list" })}>{CALENDAR_MONTH_EMPTY_RECOVERY_COPY}</a></p>
      </div>
    {/if}
  </div>
</section>
