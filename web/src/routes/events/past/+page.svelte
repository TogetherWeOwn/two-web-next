<script lang="ts">
import EventCard from "#lib/EventCard.svelte";
import Shell from "#lib/Shell.svelte";
import {
  EVENTS_EMPTY_COPY,
  EVENTS_SUBSCRIBE_TESTID,
  PAST_EVENTS_BACK_TESTID,
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_ISLAND,
  PAST_EVENTS_LIST_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  PAST_EVENTS_PAGER_NEWER_TESTID,
  PAST_EVENTS_PAGER_OLDER_TESTID,
  PAST_EVENTS_PAGER_TESTID,
  PAST_EVENTS_SEARCH_MISS_TESTID,
  PAST_EVENTS_TESTID,
  pastEventsOutOfRangeCopy,
  pastEventsUrl,
} from "../../../../../src/islands/contracts";
import { feedUrl, rssUrl, webcalUrl } from "../../../../../src/events/feeds";
import { SUBSCRIPTION_GUIDANCE } from "../../../../../src/events/subscription-copy";
import { canonicalUrl } from "../../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of PastEventsPage (src/events/pages.tsx): the island
// script, test ids and copy are shared, so the existing E2E and island apply.
let { data }: PageProps = $props();
const {
  rows,
  page,
  hasMore,
  totalPages,
  appUrl,
  q = "",
  games = [],
  game = "",
  gamesOmitted = false,
} = $derived(data);
const destination = $derived(pastEventsUrl(page, q, game));
const calendarFeedUrl = $derived(feedUrl(appUrl));
// A component-level <script> is Svelte's own; the island tags are emitted as markup.
const islands =
  '<script src="/islands/copy-link.js" defer></' +
  'script> <script src="/islands/past-events.js" defer></' +
  "script>";
// csr=false still emits a structural client route node. Keep the archive cards
// server-only, like the home-event list, so that unused asset does not carry them.
// Direct server compilation without Vite's env renders the cards normally.
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
  <section data-island={PAST_EVENTS_ISLAND} data-testid={PAST_EVENTS_TESTID} data-page={page} data-total-pages={totalPages} data-query={q} data-game={game} data-load-error={PAST_EVENTS_COPY.failed} aria-labelledby="past-events-heading">
    <div class="schedule-heading">
      <p class="strap">The archive</p>
      <h1 id="past-events-heading" tabindex="-1">Past events</h1>
      <p>Game nights we’ve shared. Find the next one in the <a href="/events">upcoming schedule</a>.</p>
    </div>
    <p>
      <a href={webcalUrl(appUrl)} data-testid={EVENTS_SUBSCRIBE_TESTID}>{EVENTS_EMPTY_COPY.subscribe}</a>{" "}
      <a href={rssUrl(appUrl)}>RSS feed</a> <a href={calendarFeedUrl}>Download calendar (.ics)</a>
    </p>
    <!-- Static mirror of subscriptionHelp() (src/events/subscription-help.tsx):
         {@html} inside this section leaves hydration anchors with no Hono
         counterpart and breaks the cross-target section contract. -->
    <details class="subscription-help" data-testid="subscription-help">
      <summary>How to subscribe to the calendar</summary>
      <p>{SUBSCRIPTION_GUIDANCE[0]}</p>
      <p>{SUBSCRIPTION_GUIDANCE[1]}</p>
      <label for="calendar-feed-url">Calendar feed URL</label>
      <div class="subscription-copy">
        <input id="calendar-feed-url" data-testid="subscription-feed-url" type="text" value={calendarFeedUrl} readonly /><button class="btn" type="button" data-testid="subscription-copy-button" data-copy-link={calendarFeedUrl} data-copy-feed="true" hidden>Copy feed URL</button>
      </div>
      <p data-testid="subscription-manual-copy">Select the feed URL and copy it manually in your calendar app.</p>
      <p role="status" aria-atomic="true" data-copy-toast data-testid="subscription-copy-status"></p>
      <p>{SUBSCRIPTION_GUIDANCE[2]}</p>
    </details>
    <div data-archive-state>
      <form method="get" action="/events/past" role="search">
        <!-- Facet labels mirror EVENTS_GAME_FILTER_LABEL / EVENTS_GAME_ALL_COPY
          (contracts-calendar) as literals: importing the calendar module would
          add a client graph edge for two strings (Kit perf budget). -->
        <label for="past-events-game-filter">Filter by game</label>
        <select id="past-events-game-filter" name="game" aria-describedby="past-events-game-scope">
          <option value="" selected={game === ""}>All games</option>
          {#each games as suggestion}<option value={suggestion} selected={suggestion === game}>{suggestion}</option>{/each}
          {#if game !== "" && !games.includes(game)}<option value={game} selected>{game}</option>{/if}
        </select>
        {#if q}<input type="hidden" name="q" value={q} />{/if}
        <button class="btn" type="submit">Search</button>
        <p id="past-events-game-scope">Games from past events.</p>
        {#if gamesOmitted}<p>Showing the first 100 games; more games exist in the archive.</p>{/if}
      </form>
      {#if q || game}
        <p role="status">
          {#if q && game}Past events matching “{q}” for game “{game}”.{" "}<a href={pastEventsUrl(1, q)}>Clear game</a>{" "}<a href={pastEventsUrl(1, "", game)}>Clear search</a>
          {:else if q}Past events matching “{q}”. <a href="/events/past">Clear search</a>
          {:else}Past events for game “{game}”.{" "}<a href="/events/past">Clear game</a>{/if}
        </p>
      {/if}
      {#if rows.length === 0}
        {#if totalPages === 0 && (q || game)}
          <p role="status" data-testid={PAST_EVENTS_SEARCH_MISS_TESTID}>
            {#if q && game}No past events match “{q}” for game “{game}”.{" "}<a href={pastEventsUrl(1, q)}>Clear game</a>{" "}<a href={pastEventsUrl(1, "", game)}>Clear search</a>
            {:else if q}No past events match “{q}”. <a href="/events/past">Clear search</a>
            {:else}No past events for game “{game}”.{" "}<a href="/events/past">Clear game</a>{/if}
          </p>
        {:else if totalPages === 0}
          <div data-testid={PAST_EVENTS_EMPTY_TESTID}>
            <p>{PAST_EVENTS_COPY.empty}</p>
            <p><a href="/join">{PAST_EVENTS_COPY.join}</a></p>
          </div>
        {:else}
          <p role="status" data-testid={PAST_EVENTS_OUT_OF_RANGE_TESTID}>{pastEventsOutOfRangeCopy(page, totalPages)}{" "}<a href={pastEventsUrl(1, q, game)}>Back to page 1</a></p>
        {/if}
      {/if}
    </div>
    <ul data-testid={PAST_EVENTS_LIST_TESTID} data-archive-list hidden={rows.length === 0}>{#if import.meta.env?.SSR !== false}{#each rows as e (e.eventKey)}<EventCard {e} {q} archive={{ page, q, game }} />{/each}{/if}</ul>
    <nav aria-label="Past event pages" data-archive-pager data-testid={PAST_EVENTS_PAGER_TESTID}>{#if page > 1 && totalPages > 0}<a data-testid={PAST_EVENTS_PAGER_NEWER_TESTID} data-archive-page href={pastEventsUrl(Math.min(page - 1, totalPages), q, game)}>Newer</a>{/if}{" "}{#if hasMore}<a data-testid={PAST_EVENTS_PAGER_OLDER_TESTID} data-archive-page href={pastEventsUrl(page + 1, q, game)}>Older</a>{/if}</nav>
    <p><a data-testid={PAST_EVENTS_BACK_TESTID} href="/events">Back to upcoming events</a></p>
    <p role="status" data-archive-feedback></p>
  </section>
  {@html islands}
</Shell>
