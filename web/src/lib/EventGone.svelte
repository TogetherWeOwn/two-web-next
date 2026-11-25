<script lang="ts">
import JsonLd from "#lib/JsonLd.svelte";
import Shell from "#lib/Shell.svelte";
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
          <span class="event-tag">Cancelled</span>
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

<style>
  @import "./event-tag.css";

  .event-tag {
    box-shadow: inset 0 0 0 1px var(--color-hair2);
    color: var(--t2);
  }

  .event-head { grid-area: head; min-width: 0; }
  .event-rail { grid-area: rail; min-width: 0; display: grid; gap: var(--space-4); }
  .event-recovery { grid-area: recovery; min-width: 0; }
  .event-layout { display: grid; gap: var(--space-4); grid-template-areas: "head" "rail" "recovery"; }
  .scheduled { border-top: 1px solid var(--color-hair1); padding-top: var(--space-5); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); }
  .scheduled > time { font-size: var(--text-figure); line-height: 1; font-variant-numeric: tabular-nums; }
  .scheduled p { margin: 0; }
  .anchor { font: var(--text-label) / var(--leading-label) var(--font-data); color: var(--color-t3); }
  .record, .event-facts { border: 0; border-radius: var(--radius-l); background: var(--color-g2); }
  .record { padding: var(--space-inset-card); }
  .record-head { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: var(--space-2); }
  .record-head h2 { margin: 0; font-size: var(--text-title); font-weight: var(--font-weight-semibold); line-height: var(--leading-title); }
  .record p { margin: var(--space-inset-tight) 0; font-size: var(--text-small); color: var(--color-t2); }
  /* Keep the full-width ghost pill in the cancelled view's stylesheet. */
  .next-date-link {
    display: inline-flex;
    vertical-align: middle;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    padding: 0 var(--space-5);
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--color-hair2);
    color: var(--t1);
    font-family: var(--font-ui);
    font-size: var(--text-ui);
    font-weight: var(--font-weight-semibold);
    font-stretch: var(--font-width-button);
    cursor: pointer;
    text-decoration: none;
  }
  .next-date-link:focus-visible { outline: var(--focus-width) solid var(--focus-ring); outline-offset: var(--focus-offset); }
  @media (hover: hover) {
    .next-date-link:hover { background: var(--g2); }
  }
  @media (forced-colors: active) {
    .next-date-link { border: 1px solid ButtonText; }
  }
  .event-facts { padding: var(--space-2) var(--space-inset-card); }
  .event-facts dl { margin: 0; }
  .event-facts dl > div { display: flex; justify-content: space-between; gap: var(--space-4); padding: var(--space-inset-tight) 0; }
  .event-facts dl > div + div { border-top: 1px solid var(--color-hair1); }
  .event-facts dt { color: var(--color-t3); font: var(--text-label) / var(--leading-label) var(--font-data); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .event-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; text-align: right; }
  /* Kit breakpoint.compact-max, layout.rail.seat, and layout.sticky-offset. */
  @media (min-width: 821px) {
    .event-layout { grid-template-columns: minmax(0, 1fr) 380px; grid-template-areas: "head rail" "recovery rail"; column-gap: var(--space-9); align-items: start; }
    .event-rail { position: sticky; top: 92px; }
  }
</style>
