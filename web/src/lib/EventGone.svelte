<script lang="ts">
import JsonLd from "#lib/JsonLd.svelte";
import Shell from "#lib/Shell.svelte";
import type { EventGoneModel } from "../../../src/kit-event-states";

// Cancelled-event presentation for GET /e/:key (card 24/43). Markup contract
// of EventGonePage (src/events/pages-gone.tsx): the hero core (kicker,
// status notice, title, upcoming button) is shared, extended here with the
// correct alternatives (upcoming same-game siblings) and the per-event
// calendar download. No canonical link (so no og:/twitter: share tags, as
// served), no RSVP, join-pitch, copy-link or attendee surface anywhere.
let { model }: { model: EventGoneModel } = $props();
</script>

<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href={model.markdownAlternate} />
</svelte:head>

<Shell
  title={model.title}
  robots="noindex, nofollow"
  theme="event"
  activeNav="event"
  hideAccount
>
  <nav class="event-back" aria-label="Event calendar">
    <a href="/events">← All events</a>
  </nav>
  <section class="event-hero event-gone" aria-label="Cancelled event">
    <p class="event-kicker">{model.game ?? "Community event"}</p>
    <p class="notice" role="status" data-testid="event-cancelled">Cancelled</p>
    <h1>{model.title}</h1>
    {#if model.related.length > 0}
      <ul class="facts" data-testid="event-cancelled-alternatives">
        {#each model.related as alternative (alternative.key)}
          <li class="card">
            <a href="/e/{alternative.key}">{alternative.title}</a>
            <p>
              <time>{alternative.whenText}</time>
              {#if alternative.location} · {alternative.location}{/if}
            </p>
          </li>
        {/each}
      </ul>
    {/if}
    <p>
      <a class="btn" href={model.upcomingUrl}>See upcoming events</a>
    </p>
    <p>
      <a href={model.icsUrl} data-testid="event-cancelled-ics">Download calendar entry (.ics)</a>
    </p>
  </section>
  <JsonLd testid="event-jsonld" json={model.jsonLd} />
  <JsonLd testid="site-jsonld" json={model.siteJsonLd} />
</Shell>
