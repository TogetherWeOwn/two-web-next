<script lang="ts">
import {
  DISCORD_JOIN_TESTID,
  EVENTS_EMPTY_COPY,
  EVENTS_EMPTY_ERROR_TESTID,
  EVENTS_EMPTY_GAP_ITEM_TESTID,
  EVENTS_EMPTY_GAP_LIST_TESTID,
  EVENTS_EMPTY_GAP_TESTID,
  EVENTS_EMPTY_NEVER_TESTID,
  EVENTS_EMPTY_SEARCH_TESTID,
  EVENTS_GAP_LIST_LIMIT,
  EVENTS_PARTIAL_COPY,
  EVENTS_PARTIAL_TESTID,
  EVENTS_RETRY_TESTID,
  EVENTS_SEARCH_CLEAR_EMPTY_TESTID,
  calendarUrl,
  cardTimeLabel,
  eventPageUrl,
  eventsSearchGameMissCopy,
  eventsSearchMissCopy,
  type CalendarState,
} from "../../../src/islands/contracts";

/** Public fields only; the caller projects and orders past events. */
type GapEvent = {
  eventKey: string;
  title: string;
  startsAt: Date;
  timezone: string;
  status: string;
};
let {
  kind,
  state,
  gameFilter,
  past,
  inviteUrl,
}: {
  kind: "never" | "gap" | "error" | "partial" | "miss";
  state: CalendarState;
  gameFilter: string | null;
  past: GapEvent[];
  inviteUrl: string;
} = $props();
</script>

{#if kind === "never"}
  <div data-testid={EVENTS_EMPTY_NEVER_TESTID}>
    <h2>{EVENTS_EMPTY_COPY.neverTitle}</h2>
    <p>{EVENTS_EMPTY_COPY.neverBody}</p>
    <p><a href={inviteUrl} data-testid={DISCORD_JOIN_TESTID}>{EVENTS_EMPTY_COPY.join}</a></p>
  </div>
{:else if kind === "gap"}
  <div data-testid={EVENTS_EMPTY_GAP_TESTID}>
    <h2>{EVENTS_EMPTY_COPY.gapTitle}</h2>
    <h3>{EVENTS_EMPTY_COPY.gapListHeading}</h3>
    <ul data-testid={EVENTS_EMPTY_GAP_LIST_TESTID}>
      {#each past.slice(0, EVENTS_GAP_LIST_LIMIT) as event}
        <li data-testid={EVENTS_EMPTY_GAP_ITEM_TESTID}>
          {#if event.status === "cancelled"}{event.title}{:else}<a href={eventPageUrl(event.eventKey)}>{event.title}</a>{/if}{" "}
          <time datetime={event.startsAt.toISOString()}>{cardTimeLabel(event.startsAt, event.timezone)}</time>
        </li>
      {/each}
    </ul>
    <p><a href="/events/past">{EVENTS_EMPTY_COPY.pastArchive}</a></p>
  </div>
{:else if kind === "error" || kind === "partial"}
  <div data-testid={kind === "error" ? EVENTS_EMPTY_ERROR_TESTID : EVENTS_PARTIAL_TESTID}>
    {#if kind === "error"}<h2>{EVENTS_EMPTY_COPY.errorTitle}</h2><p>{EVENTS_EMPTY_COPY.errorBody}</p>{:else}<p>{EVENTS_PARTIAL_COPY.notice}</p>{/if}
    <div class="schedule-recovery-actions"><a href={calendarUrl(state)} data-testid={EVENTS_RETRY_TESTID}>{EVENTS_EMPTY_COPY.retry}</a><a href={inviteUrl} data-testid={DISCORD_JOIN_TESTID}>{EVENTS_EMPTY_COPY.join}</a></div>
  </div>
{:else}
  <div data-testid={EVENTS_EMPTY_SEARCH_TESTID}>
    <h2>{state.q.trim() ? EVENTS_EMPTY_COPY.searchMissTitle : "No upcoming events for this game."}</h2>
    <p>{gameFilter !== null ? state.q.trim() ? eventsSearchGameMissCopy(state.q, gameFilter) : `No upcoming events for “${gameFilter}”.` : eventsSearchMissCopy(state.q)}</p>
    {#if state.q.trim()}
      <p>{EVENTS_EMPTY_COPY.searchMissBody}</p>
      <p><a href={calendarUrl({ ...state, q: "", page: 1 })} data-testid={EVENTS_SEARCH_CLEAR_EMPTY_TESTID}>{EVENTS_EMPTY_COPY.searchMissClear}</a></p>
    {/if}
    {#if gameFilter !== null}<p><a href={calendarUrl({ ...state, game: "", page: 1 })}>{state.q.trim() ? "Search all games" : "Show all games"}</a></p>{/if}
  </div>
{/if}
