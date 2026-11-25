<script lang="ts">
import JsonLd from "#lib/JsonLd.svelte";
import Shell from "#lib/Shell.svelte";
import Tag from "#lib/Tag.svelte";
import { EXISTING_RESPONSES_TESTID, existingResponsesText } from "../../../src/islands/contracts";
import type { EventGoneModel } from "../../../src/kit-event-states";

let { model }: { model: EventGoneModel } = $props();
</script>

<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href={model.markdownAlternate} />
</svelte:head>

<Shell
  title={model.title}
  robots="noindex, nofollow"
  theme="event"
  mainClass="kit-event-cancelled"
  activeNav="event"
  hideAccount
>
  <div class="event-layout">
    <div class="event-head">
      <nav class="event-back" aria-label="Event calendar">
        <a href="/events">← All events</a>
      </nav>
      <section class="event-hero event-gone" aria-label="Cancelled event">
        <p class="event-kicker">{model.game ?? "Community event"}</p>
        <p class="notice" role="status" data-testid="event-cancelled">Cancelled</p>
        <h1>{model.title}</h1>
        {#if model.scheduled}
          <div class="scheduled">
            <time data-testid="event-cancelled-time" datetime={model.scheduled.datetime}><s>{model.scheduled.clock}</s></time>
            <div>
              <p>Cancelled · {model.scheduled.day}</p>
              <p class="anchor">{model.scheduled.anchor}</p>
            </div>
          </div>
        {/if}
      </section>
    </div>
    <div class="event-rail">
      <section class="record" aria-labelledby="event-cancelled-record-heading" data-testid="event-cancelled-record">
        <div class="record-head">
          <h2 id="event-cancelled-record-heading">Cancelled</h2>
          <Tag>Cancelled</Tag>
        </div>
        <p data-testid={EXISTING_RESPONSES_TESTID}>{existingResponsesText(model.existingResponses)}</p>
        {#if model.nextDate}
          <p>Next one: <time datetime={model.nextDate.datetime}>{model.nextDate.whenText}</time></p>
        {/if}
        <p>Nothing else to do.</p>
        {#if model.nextDate}
          <a class="next-date-link" href={model.nextDate.href}>See the next date</a>
        {/if}
      </section>
      {#if model.facts.length > 0}
        <section class="event-facts" aria-label="Event facts" data-testid="kit-event-facts">
          <dl>
            {#each model.facts as fact (fact.key)}
              <div><dt>{fact.key}</dt><dd>{fact.value}</dd></div>
            {/each}
          </dl>
        </section>
      {/if}
    </div>
    <div class="event-recovery">
      <p><a class="btn" href={model.upcomingUrl}>See upcoming events</a></p>
      <p><a href={model.icsUrl} data-testid="event-cancelled-ics">Download calendar entry (.ics)</a></p>
      {#if model.related.length > 0}
        <section aria-labelledby="event-cancelled-alternatives-heading">
          <h2 id="event-cancelled-alternatives-heading">Other upcoming events</h2>
          <ul class="facts" role="list" aria-labelledby="event-cancelled-alternatives-heading" data-testid="event-cancelled-alternatives">
            {#each model.related as alternative (alternative.key)}
              <li class="card">
                <a href="/e/{alternative.key}" data-testid="event-cancelled-alternative">{alternative.title}</a>
                <p>
                  <time datetime={alternative.datetime}>{alternative.whenText}</time>
                  {#if alternative.location} · {alternative.location}{/if}
                </p>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>
  </div>
  <JsonLd testid="event-jsonld" json={model.jsonLd} />
  <JsonLd testid="site-jsonld" json={model.siteJsonLd} />
</Shell>
