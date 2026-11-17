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

// Mirrors PastDrawer in src/events/pages-calendar-list.tsx. Both views render
// it, so a preview opened in one view closes in the other. Hide only closes a
// manually opened preview: a non-blank search forces past matches open, and
// clearing the manual flag there would leave cards behind a control claiming
// to hide them, so search screens offer no Hide at all.
let { state, past, showPast, member, inviteUrl, loginReturnTo }: CalendarPastDrawerProps = $props();
</script>

{#if showPast && past.length > 0}
  <div>
    <h2>{EVENTS_PAST_LIST_HEADING}</h2>
    {#if state.past && !calendarSearching(state)}
      <p><a href={calendarUrl({ ...state, past: false })} data-testid={EVENTS_PAST_TOGGLE_TESTID}>{EVENTS_PAST_HIDE_COPY}</a></p>
    {/if}
    <ul data-testid={EVENTS_PAST_LIST_TESTID}>
      {#each past as e (e.key)}
        <CalendarCard {e} isPast {member} {inviteUrl} {loginReturnTo} />
      {/each}
    </ul>
  </div>
{/if}
{#if !showPast && past.length > 0}
  <p><a href={calendarUrl({ ...state, past: true })} data-testid={EVENTS_PAST_TOGGLE_TESTID}>{EVENTS_PAST_TOGGLE_COPY}</a></p>
{/if}
