<script lang="ts">
import EventCard from "#lib/EventCard.svelte";
import Shell from "#lib/Shell.svelte";
import {
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_ISLAND,
  PAST_EVENTS_LIST_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  PAST_EVENTS_TESTID,
  pastEventsOutOfRangeCopy,
  pastEventsUrl,
} from "../../../../../src/islands/contracts";
import { canonicalUrl } from "../../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of PastEventsPage (src/events/pages.tsx): the island
// script, test ids and copy are shared, so the existing E2E and island apply.
let { data }: PageProps = $props();
const { rows, page, hasMore, totalPages, appUrl } = $derived(data);
const destination = $derived(pastEventsUrl(page));
// A component-level <script> is Svelte's own; the island tag is emitted as markup.
const island = '<script src="/islands/past-events.js" defer></' + "script>";
</script>

<Shell
  title="Past events"
  canonical={canonicalUrl(appUrl, destination)}
  robots="noindex, follow"
  description="Look back at the community’s game nights and tournaments."
  loginReturnTo={destination}
>
  <section data-island={PAST_EVENTS_ISLAND} data-testid={PAST_EVENTS_TESTID} data-page={page} data-total-pages={totalPages} data-load-error={PAST_EVENTS_COPY.failed} aria-labelledby="past-events-heading">
    <div class="schedule-heading">
      <p class="strap">The archive</p>
      <h1 id="past-events-heading" tabindex="-1">Past events</h1>
      <p>Game nights we’ve shared. Find the next one in the upcoming schedule.</p>
    </div>
    <div data-archive-state>
      {#if rows.length === 0}
        {#if totalPages === 0}
          <div data-testid={PAST_EVENTS_EMPTY_TESTID}>
            <p>{PAST_EVENTS_COPY.empty}</p>
            <p><a href="/join">{PAST_EVENTS_COPY.join}</a></p>
          </div>
        {:else}
          <p role="status" data-testid={PAST_EVENTS_OUT_OF_RANGE_TESTID}>{pastEventsOutOfRangeCopy(page, totalPages)}</p>
        {/if}
      {/if}
    </div>
    <ul data-testid={PAST_EVENTS_LIST_TESTID} data-archive-list hidden={rows.length === 0}>{#each rows as e (e.eventKey)}<EventCard {e} />{/each}</ul>
    <nav aria-label="Past event pages" data-archive-pager>{#if page > 1 && totalPages > 0}<a data-archive-page href={pastEventsUrl(Math.min(page - 1, totalPages))}>Newer</a>{/if}{" "}{#if hasMore}<a data-archive-page href={pastEventsUrl(page + 1)}>Older</a>{/if}</nav>
    <p><a href="/events">Back to upcoming events</a></p>
    <p role="status" data-archive-feedback></p>
  </section>
  {@html island}
</Shell>
