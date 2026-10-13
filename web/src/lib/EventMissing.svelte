<script lang="ts">
import Shell from "#lib/Shell.svelte";
import type { EventMissingModel } from "../../../src/kit-event-states";

// Missing-event presentation for GET /e/:key (card 24/43): the branded 404
// with the same recovery contract as NotFoundPage (src/error-pages.tsx) —
// the "Happening soon" suggestions section below is its markup twin, so the
// section comparison in test/kit-event-states.test.ts holds. Recovery stays
// available with an empty calendar or a failed lookup: the model carries the
// fallback, never the database.
let { model }: { model: EventMissingModel } = $props();
</script>

<Shell title="We cannot find that page" robots="noindex, nofollow" theme="home">
  <section class="hero recovery-hero" aria-labelledby="error-heading">
    <div class="hero-detail hero-detail-left" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <div class="hero-detail hero-detail-right" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>
    <p class="recovery-code" aria-hidden="true">404</p>
    <h1 id="error-heading">We cannot find that page</h1>
    <p class="lead">
      The link may be old or mistyped, or the page may have moved. The lobby is still open — come in
      and say hello.
    </p>
    <p class="recovery-actions">
      <a class="btn" href="/auth/discord" data-testid="error-join">Join with Discord</a>
      <a href="/" data-testid="error-home">Back to the homepage</a>
    </p>
  </section>
  <section
    class="recovery-events"
    aria-labelledby="error-events-heading"
    data-testid="error-event-suggestions"
  >
    <h2 id="error-events-heading">Happening soon</h2>
    {#if model.suggestions.length > 0}
      <ul class="facts">
        {#each model.suggestions as suggestion (suggestion.key)}
          <li class="card">
            <a href="/e/{suggestion.key}" data-testid="error-event-suggestion">{suggestion.title}</a>
            <p>
              <time datetime={suggestion.datetime}>{suggestion.whenText}</time>
              {#if suggestion.location} · {suggestion.location}{/if}
            </p>
          </li>
        {/each}
      </ul>
    {:else}
      <p data-testid="error-events-empty">Nothing is on the calendar right now — check back soon.</p>
    {/if}
    <p>
      <a href="/events" data-testid="error-all-events">Browse all events</a>
    </p>
    <form action="/events" method="get" role="search" class="error-events-search">
      <label for="error-events-search">Search events</label>
      <div>
        <input
          id="error-events-search"
          name="q"
          type="search"
          placeholder="Search events…"
          autocomplete="off"
          data-testid="error-events-search"
        />
        <button type="submit" class="btn" data-testid="error-events-search-submit">
          Search events
        </button>
      </div>
    </form>
  </section>
</Shell>
