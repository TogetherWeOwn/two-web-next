<script lang="ts">
import {
  EVENTS_PAST_HIDE_COPY,
  EVENTS_PAST_LIST_HEADING,
  EVENTS_PAST_LIST_TESTID,
  EVENTS_PAST_TOGGLE_COPY,
  EVENTS_PAST_TOGGLE_TESTID,
  calendarSearching,
  calendarUrl,
} from "../../../src/islands/contracts";
import CalendarCard from "./CalendarCard.svelte";
import type { CalendarPastDrawerProps } from "./calendar-list";

// Search forces the preview open, so only a manual preview offers Hide.
let { state, past, showPast, member, inviteUrl, loginReturnTo }: CalendarPastDrawerProps = $props();
</script>

{#if showPast && past.length > 0}
  <div>
    <h2 id="calendar-past-heading">{EVENTS_PAST_LIST_HEADING}</h2>
    {#if state.past && !calendarSearching(state)}
      <p><a href={calendarUrl({ ...state, past: false })} data-testid={EVENTS_PAST_TOGGLE_TESTID}>{EVENTS_PAST_HIDE_COPY}</a></p>
    {/if}
    <ul role="list" aria-labelledby="calendar-past-heading" data-testid={EVENTS_PAST_LIST_TESTID}>
      {#each past as e (e.key)}
        <CalendarCard {e} isPast {member} {inviteUrl} {loginReturnTo} />
      {/each}
    </ul>
  </div>
{/if}
{#if !showPast && past.length > 0}
  <p><a href={calendarUrl({ ...state, past: true })} data-testid={EVENTS_PAST_TOGGLE_TESTID}>{EVENTS_PAST_TOGGLE_COPY}</a></p>
{/if}
