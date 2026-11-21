<script lang="ts">
import {
  EVENTS_LIST_HEADING_SR,
  EVENTS_LIST_TESTID,
  EVENTS_OUT_OF_RANGE_TESTID,
  EVENTS_PAGE_UNREADABLE_TESTID,
  EVENTS_PAGER_FIRST_COPY,
  EVENTS_PAGER_FIRST_TESTID,
  EVENTS_PAGER_LABEL,
  EVENTS_PAGER_LAST_COPY,
  EVENTS_PAGER_LAST_TESTID,
  EVENTS_PAGER_NEXT_COPY,
  EVENTS_PAGER_NEXT_TESTID,
  EVENTS_PAGER_PREV_COPY,
  EVENTS_PAGER_PREV_TESTID,
  EVENTS_PAGER_STATUS_TESTID,
  EVENTS_PAGER_TESTID,
  calendarUrl,
  cardDayLabel,
  wallDateIso,
  upcomingEventsOutOfRangeCopy,
  upcomingEventsPageStatusCopy,
  upcomingEventsPageUnreadableCopy,
} from "../../../src/islands/contracts";
import CalendarCard from "./CalendarCard.svelte";
import CalendarPastDrawer from "./CalendarPastDrawer.svelte";
import type { CalendarListProps } from "./calendar-list";

// Mirrors CalendarList in src/events/pages-calendar-list.tsx. The caller gates
// it on the empty state and the view. Page turns are real anchors, so they work
// without JavaScript and the island binder can still upgrade them to fragment swaps.
let {
  state,
  zone,
  now,
  upcoming,
  past,
  totalPages,
  outOfRange,
  pageUnreadable = false,
  showPast,
  member,
  inviteUrl,
  loginReturnTo,
}: CalendarListProps & { pageUnreadable?: boolean; zone: string; now: Date } = $props();
const today = $derived(wallDateIso(now, zone));
const days = $derived(upcoming.map((event) => wallDateIso(event.startsAt, zone)));

// First from any later or unavailable page; an out-of-range request therefore
// recovers straight to page one. Previous clamps only out of range.
const previousPage = $derived(outOfRange ? Math.min(state.page - 1, totalPages) : state.page - 1);
</script>

<div>
  {#if outOfRange}
    <p role="status" data-testid={EVENTS_OUT_OF_RANGE_TESTID}>{upcomingEventsOutOfRangeCopy(state.page, totalPages)}</p>
  {:else if pageUnreadable}
    <p data-testid={EVENTS_PAGE_UNREADABLE_TESTID}>{upcomingEventsPageUnreadableCopy(state.page)}</p>
  {/if}
  <h2 class="sr-only">{EVENTS_LIST_HEADING_SR}</h2>
  <ul data-testid={EVENTS_LIST_TESTID}>
    {#each upcoming as e, index (e.key)}
      {#if days[index] !== days[index - 1]}
        <li class="schedule-day"><h3>{days[index] === today ? "Today · " : ""}{cardDayLabel(e.startsAt, zone)}</h3></li>
      {/if}
      <CalendarCard {e} isPast={false} {member} {inviteUrl} {loginReturnTo} />
    {/each}
  </ul>
  {#if totalPages > 1 || outOfRange || pageUnreadable}
    <nav aria-label={EVENTS_PAGER_LABEL} data-testid={EVENTS_PAGER_TESTID}>
      {#if state.page > 1}<a href={calendarUrl({ ...state, page: 1 })} data-testid={EVENTS_PAGER_FIRST_TESTID}>{EVENTS_PAGER_FIRST_COPY}</a>{" "}{/if}
      {#if state.page > 1}<a href={calendarUrl({ ...state, page: previousPage })} data-testid={EVENTS_PAGER_PREV_TESTID}>{EVENTS_PAGER_PREV_COPY}</a>{/if}{" "}
      <!-- The requested page, never clamped: an unavailable page must not be announced as the last valid page. -->
      <span role="status" data-testid={EVENTS_PAGER_STATUS_TESTID}>{upcomingEventsPageStatusCopy(state.page, totalPages)}</span>{" "}
      {#if state.page < totalPages}<a href={calendarUrl({ ...state, page: state.page + 1 })} data-testid={EVENTS_PAGER_NEXT_TESTID}>{EVENTS_PAGER_NEXT_COPY}</a>{/if}
      {#if totalPages > 1 && state.page < totalPages}{" "}<a href={calendarUrl({ ...state, page: totalPages })} data-testid={EVENTS_PAGER_LAST_TESTID}>{EVENTS_PAGER_LAST_COPY}</a>{/if}
    </nav>
  {/if}
  <CalendarPastDrawer {state} {past} {showPast} {member} {inviteUrl} {loginReturnTo} />
</div>
