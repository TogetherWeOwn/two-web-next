<script lang="ts">
import EventCard from "#lib/EventCard.svelte";
import Shell from "#lib/Shell.svelte";
import {
  EVENTS_EMPTY_COPY,
  EVENTS_SUBSCRIBE_TESTID,
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_ISLAND,
  PAST_EVENTS_LIST_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  PAST_EVENTS_TESTID,
  pastEventsOutOfRangeCopy,
  pastEventsUrl,
} from "../../../../../src/islands/contracts";
import { feedUrl, rssUrl, webcalUrl } from "../../../../../src/events/feeds";
import { canonicalUrl } from "../../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of PastEventsPage (src/events/pages.tsx): the island
// script, test ids and copy are shared, so the existing E2E and island apply.
let { data }: PageProps = $props();
const { rows, page, hasMore, totalPages, appUrl, q = "" } = $derived(data);
const destination = $derived(pastEventsUrl(page, q));
// A component-level <script> is Svelte's own; the island tag is emitted as markup.
const island = '<script src="/islands/past-events.js" defer></' + "script>";
</script>

<Shell
  title="Past events"
  canonical={canonicalUrl(appUrl, destination)}
  robots="noindex, follow"
  description="Look back at the community’s game nights and tournaments."
  theme="schedule"
  activeNav="events"
  mainClass="events-page"
  loginReturnTo={destination}
>
  <section data-island={PAST_EVENTS_ISLAND} data-testid={PAST_EVENTS_TESTID} data-page={page} data-total-pages={totalPages} data-query={q} data-load-error={PAST_EVENTS_COPY.failed} aria-labelledby="past-events-heading">
    <div class="schedule-heading">
      <p class="strap">The archive</p>
      <h1 id="past-events-heading" tabindex="-1">Past events</h1>
      <p>Game nights we’ve shared. Find the next one in the upcoming schedule.</p>
    </div>
    <p>
      <a href={webcalUrl(appUrl)} data-testid={EVENTS_SUBSCRIBE_TESTID}>{EVENTS_EMPTY_COPY.subscribe}</a>{" "}
      <a href={rssUrl(appUrl)}>RSS feed</a> <a href={feedUrl(appUrl)}>Download calendar (.ics)</a>
    </p>
    <!-- Plain GET navigation outside the binder's swapped zones: submitting
        starts from page 1 with JS off, and fragment turns never swallow it.
        Same shape as the calendar search form. -->
    <form method="get" action="/events/past" role="search">
      <label class="sr-only" for="past-events-search-input">Search past events</label>
      <input id="past-events-search-input" type="search" name="q" value={q} placeholder="Search past events" />
      <button class="btn" type="submit">Search</button>
    </form>
    <div data-archive-state>
      {#if q}<p role="status">Past events matching “{q}”. <a href="/events/past">Clear search</a></p>{/if}
      {#if rows.length === 0}
        {#if totalPages === 0 && q}
          <p role="status">No past events match your search.</p>
        {:else if totalPages === 0}
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
    <nav aria-label="Past event pages" data-archive-pager>{#if page > 1 && totalPages > 0}<a data-archive-page href={pastEventsUrl(Math.min(page - 1, totalPages), q)}>Newer</a>{/if}{" "}{#if totalPages > 0}<span>Page {page} of {totalPages}</span>{/if}{" "}{#if hasMore}<a data-archive-page href={pastEventsUrl(page + 1, q)}>Older</a>{/if}</nav>
    <p><a href="/events">Back to upcoming events</a></p>
    <p role="status" data-archive-feedback></p>
  </section>
  {@html island}
</Shell>
