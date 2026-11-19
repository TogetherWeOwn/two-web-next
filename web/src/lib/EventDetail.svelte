<script lang="ts">
import JsonLd from "#lib/JsonLd.svelte";
import Shell from "#lib/Shell.svelte";
import Tag from "#lib/Tag.svelte";
import type { KitEventDetailModel } from "../../../src/events/kit-detail";
import { kitEventFacts } from "../../../src/events/kit-event-facts";
import { kitOpenSeat, KIT_SIGNUPS_OPEN } from "../../../src/events/kit-seat-actions";
import { ONGOING_COPY } from "../../../src/events/ongoing";
import { isPublicJoinUrl } from "../../../src/events/public-join-url";
import { HOME_JOIN_RESULT_COPY } from "../../../src/home-copy";
import { EVENT_ONGOING_TESTID } from "../../../src/islands/contracts";

// Member metadata, RSVP and roster are escaped server leaves shared with Hono.
// Mutation ownership and native island mounts stay unchanged; this route is csr=false.
let { model, restoredWrite = false }: { model: KitEventDetailModel; restoredWrite?: boolean } =
  $props();
const facts = $derived(kitEventFacts(model));
const openSeat = $derived(kitOpenSeat(model));
const seatHeading = $derived(openSeat ?? model.seatCard.heading);

// A component-level <script> is Svelte's own; the island tags are emitted as
// markup so the existing E2E and islands apply unchanged (past-page pattern).
// This route is csr=false. Share one native-island block in execution order;
// every deferred script runs after parsing, with all of its mount nodes present.
const detailIslands = [
  "event-device-timezone",
  "event-time-from-now",
  "rsvp-button",
  "copy-link",
  "event-share",
  "going-count",
  "attendees-live",
]
  .map((name) => `<script src="/islands/${name}.js" defer></` + "script>")
  .join("");
</script>

<svelte:head>
  {#if model.markdownAlternate}
    <link
      rel="alternate"
      type="text/markdown"
      title="Markdown version"
      href={model.markdownAlternate}
    />
  {/if}
</svelte:head>

{#snippet destinationPreview(event: NonNullable<KitEventDetailModel["neighbors"]["previous"]>)}
  <time datetime={event.datetime}>{event.whenText}</time>
  {#if event.location}
    {" "}<span class="event-related-location">{event.location}</span>
  {/if}
  {#if event.game}
    {" "}<span class="event-related-game">{event.game}</span>
  {/if}
  {#if event.availability}
    {" "}<span class="event-related-state">{event.availability}</span>
  {/if}
{/snippet}

{#snippet eventPagination(neighbors: KitEventDetailModel["neighbors"] | null | undefined, series: boolean)}
  {#snippet eventLink(event: KitEventDetailModel["neighbors"]["previous"], previous: boolean)}
    {#if event}
      <a
        href="/e/{event.key}"
        rel={previous ? "prev" : "next"}
        data-testid="event-{series ? 'series-' : ''}{previous ? 'previous' : 'next'}"
      >
        <span>{previous ? "← Previous" : "Next"} {series ? "in series" : "event"}: {event.title}{previous ? "" : " →"}</span>{" "}
        {@render destinationPreview(event)}
      </a>
    {/if}
  {/snippet}
  {#if neighbors && (neighbors.previous || neighbors.next)}
    <nav
      class="event-pagination"
      aria-label={series ? "Series events" : "More events"}
      data-testid={series ? "event-series-nav" : "event-pagination"}
    >
      {@render eventLink(neighbors.previous, true)}{" "}
      {@render eventLink(neighbors.next, false)}
    </nav>
  {/if}
{/snippet}

{#snippet memberChrome()}
  <form method="post" action="/logout">
    <span class="account-caption">Signed in</span>
    <span class="who">{model.viewerUsername}</span>
    <button type="submit" class="link">Sign out</button>
  </form>
{/snippet}
<Shell
  {restoredWrite}
  title={model.title}
  canonical={model.canonical}
  robots={model.robots ?? undefined}
  description={model.shareDescription}
  shareTitle="{model.title} — Together We Own"
  theme="event"
  activeNav="event"
  member={model.viewerMember}
  loginReturnTo={model.path}
  accountChrome={model.viewerUsername ? memberChrome : undefined}
>
  <div class="event-layout">
  <div class="event-layout-head">
  <nav class="event-back" aria-label="Event calendar">
    <a href={model.archiveReturn?.href ?? "/events"}>{model.archiveReturn?.label ?? "← All events"}</a>
  </nav>
  {#if model.viewerModerator && model.review}{@html model.review.banner}{/if}
  {#if model.viewerModerator && model.publishedNotice}{@html model.publishedNotice}{/if}
  <section class="event-hero" aria-label="Event overview">
    <p class="event-kicker">{model.game ?? "Community event"}</p>
    {#if model.isDraft}
      <p class="notice" data-testid="event-draft">Draft</p>
    {/if}
    {#if model.isPast}
      <p class="notice" data-testid="event-past">Past event</p>
    {/if}
    {#if model.status === "cancelled"}
      <p class="notice" role="status" data-testid="event-cancelled">Cancelled</p>
    {/if}
    {#if model.isOngoing}
      <p class="notice" data-testid={EVENT_ONGOING_TESTID}>{ONGOING_COPY}</p>
    {/if}
    {#if openSeat}<span class="seat-open-snapshot"><Tag variant="ok">{KIT_SIGNUPS_OPEN}</Tag></span>{/if}
    <h1 data-waitlist-position={model.waitlistPosition ?? ""}>{model.title}</h1>
  </section>
  {#if model.joinResult}
    <p class="notice" role="status" data-testid="join-result">
      {#if model.joinResult === "added"}
        {HOME_JOIN_RESULT_COPY.added}
      {:else}
        {HOME_JOIN_RESULT_COPY.alreadyInServer}
        {" "}<a href="/discord" data-testid="reinvite-link">{HOME_JOIN_RESULT_COPY.reinvite}</a>
      {/if}
    </p>
  {/if}
  {@html model.detailHtml.metadata}
  </div>
  <div class="event-layout-rail">
    <section class="seat-card" aria-labelledby={seatHeading ? 'seat-card-heading' : undefined} aria-label={seatHeading ? undefined : 'RSVP'} data-testid="kit-seat-card">
      {#if seatHeading}
        <div class="seat-card-head">
          <h2 id="seat-card-heading">
            {#if openSeat}
              <span class="seat-open-snapshot">{seatHeading}</span><span class="seat-open-fallback">{model.seatCard.heading}</span>
            {:else}{seatHeading}{/if}
          </h2>
          {#if openSeat}<span class="seat-open-snapshot"><Tag variant="ok">{KIT_SIGNUPS_OPEN}</Tag></span>
          {:else if model.seatCard.tag}<span class="seat-card-tag">{model.seatCard.tag.text}</span>{/if}
        </div>
      {/if}
      <div class="event-rsvp">{@html model.detailHtml.rsvp}</div>
      {#if openSeat}<a class="seat-action" href={model.icsUrl}>Add to calendar</a>{/if}
      {#if model.seatCard.note}<p class="seat-card-note">{model.seatCard.note}</p>{/if}
    </section>
    {#if facts.length > 0}
      <section class="event-facts" aria-label="Event facts" data-testid="kit-event-facts">
        <dl>
          {#each facts as fact (fact.key)}
            <div>
              <dt>{fact.key}</dt>
              <dd>
                {#if fact.key === "Host"}
                  <p data-testid="event-organizer">{fact.value}</p>
                {:else}
                  {fact.value}
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      </section>
    {/if}
    {@html model.detailHtml.share}
  </div>
  <div class="event-layout-body">
  <div class="event-detail-grid">
    <div>
      {#if model.description}
        <section class="event-description" aria-labelledby="event-description-heading">
          <h2 id="event-description-heading">About this event</h2>
          <p>{model.description}</p>
        </section>
      {/if}
      {#if model.accessibilityNotes}
        <section
          class="event-description"
          data-testid="event-accessibility"
          aria-labelledby="event-accessibility-heading"
        >
          <h2 id="event-accessibility-heading">Accessibility</h2>
          <p>{model.accessibilityNotes}</p>
        </section>
      {/if}
      {#if (model.status === "published" || model.status === "draft") && (model.joinUrl || model.joinInstructions)}
        <section
          class="event-description event-join-details"
          aria-labelledby="event-join-details-heading"
          data-testid="event-join-details"
        >
          <h2 id="event-join-details-heading">How to join</h2>
          {#if model.joinUrl}
            <p>
              {#if model.status === "published" && isPublicJoinUrl(model.joinUrl)}
                <a href={model.joinUrl} data-testid="event-public-join-link">
                  Open the public joining link
                </a>
              {:else}
                Public joining link: {model.joinUrl}
              {/if}
            </p>
          {/if}
          {#if model.joinInstructions}
            <p data-testid="event-join-instructions">{model.joinInstructions}</p>
          {/if}
        </section>
      {/if}
      {#if model.showJoinPitch}
        <section class="event-pitch" data-testid="event-join-pitch" aria-label="Join the community">
          <p>
            Game nights get posted here first. Join the Discord and you&apos;ll see them before
            they land on this page.
          </p>
          <p>
            <a
              class="btn"
              href="/join?next={encodeURIComponent(model.path)}"
              data-testid="discord-join"
            >
              Join the Discord
            </a>
          </p>
        </section>
      {/if}
    </div>
  </div>
  {@html model.detailHtml.roster}
  </div>
  </div>
  {@html detailIslands}
  <JsonLd testid="event-jsonld" json={model.jsonLd} />
  <JsonLd testid="site-jsonld" json={model.siteJsonLd} />
  <div class="event-discovery">{@render eventPagination(model.series, true)}{@render eventPagination(model.neighbors, false)}
    {#if model.related.length > 0}
      <section aria-label="Related events" data-testid="event-related">
        <h2>More events you might like</h2>
        <ul class="event-related-grid">
          {#each model.related as event (event.key)}
            <li>
              <a href="/e/{event.key}" data-testid="event-related-link">
                {event.title}{" "}
                {@render destinationPreview(event)}
              </a>
            </li>
          {/each}
        </ul>
        {#if model.showJoinPitch}
          <p>
            These fill up fast for members. Join the Discord and you&apos;ll hear about the
            next one before it lands here.
          </p>
          <a
            class="btn"
            href="/join?next={encodeURIComponent(model.path)}"
            data-testid="event-related-join"
          >
            Join the Discord
          </a>
        {/if}
      </section>
    {/if}
  </div>
  {#if model.viewerModerator && model.review}{@html model.review.actions}{/if}
</Shell>

<style>
  .event-layout-head { grid-area: head; min-width: 0; }
  .event-layout-rail { grid-area: rail; min-width: 0; display: flex; flex-direction: column; gap: var(--space-4); }
  .event-layout-rail :global(> section) { border: 0; }
  .event-layout-rail :global(> .event-share) { padding: 0; margin-top: var(--space-2); }
  .event-layout-body { grid-area: body; min-width: 0; }
  .seat-card {
    background: var(--color-g2);
    border: 0;
    border-radius: var(--radius-l);
    padding: var(--space-inset-card);
  }
  .event-facts { background: var(--color-g2); border-radius: var(--radius-l); padding: var(--space-2) var(--space-inset-card); }
  .event-facts dl { margin: 0; }
  .event-facts dl > div { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-4); padding: var(--space-inset-tight) 0; }
  .event-facts dl > div + div { border-top: 1px solid var(--color-hair1); }
  .event-facts dt { margin: 0; color: var(--color-t3); font: var(--text-label) / var(--leading-label) var(--font-data); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .event-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; text-align: right; color: var(--color-t1); font-size: var(--text-ui); }
  .event-facts dd p { margin: 0; }
  .seat-card-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-inset-tight); }
  .seat-card-head h2 { margin: 0; font-size: var(--text-title); font-weight: var(--font-weight-semibold); line-height: var(--leading-title); }
  .seat-card-tag { padding: var(--space-inset-tag-y) var(--space-inset-tag-x); border-radius: var(--radius-s); color: var(--color-warn); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-warn) 45%, transparent); font: var(--text-label) / var(--leading-label) var(--font-data); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .seat-card-note { margin: var(--space-inset-tight) 0 0; font-size: var(--text-small); color: var(--color-t2); }
  :global(.event-theme) .seat-card :global(.event-rsvp) { display: block; margin: 0; }
  :global(.event-theme) .seat-card :global(.event-rsvp > section),
  :global(.event-theme) .seat-card :global(.event-rsvp form) { align-items: stretch; gap: var(--space-inset-tight); text-align: left; }
  :global(.event-theme) .seat-card :global(.event-rsvp > section > a),
  :global(.event-theme) .seat-card :global(.event-rsvp button) { width: 100%; box-sizing: border-box; }
  :global(.event-theme) .event-detail-grid { grid-template-columns: minmax(0, 1fr); gap: 0; }
  /* Native C5 calendar link with the Kit pill treatment. */
  .seat-action {
    display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
    min-height: 44px; border: 0; border-radius: var(--radius-pill); padding: 0 var(--space-5);
    box-shadow: inset 0 0 0 1px var(--color-hair2); background: transparent; color: var(--color-t1);
    font: var(--font-weight-semibold) var(--text-ui) var(--font-ui);
    font-stretch: var(--font-width-button); text-decoration: none; cursor: pointer;
  }
  .seat-action:focus-visible { outline: var(--focus-width) solid var(--focus-ring); outline-offset: var(--focus-offset); }
  .seat-card > .seat-action { width: 100%; margin-top: var(--space-3); }
  @media (forced-colors: active) { .seat-action { border: 1px solid ButtonText; } }
  .seat-open-fallback { display: none; }
  /* C5 owns the initial availability. After an inline write the lineup badge
     takes over, even if the inline join control later returns. */
  .event-layout :global([data-event-lineup]:has([data-seat-refresh]:not([data-seat-refresh="ready"]))) { display: none; }
  .event-layout :global([data-seat-refresh] [data-spots]:not([hidden]))::before { content: " · "; }
  .event-layout:has(:global([data-seat-refresh]:not([data-seat-refresh="initial"]))),
  .event-layout:not(:has(:global([data-testid="rsvp-going"]))),
  .event-layout:has(:global([data-island="rsvp-button"][data-outcome-unknown])) {
    .seat-open-snapshot { display: none; }
    .seat-open-fallback { display: inline; }
  }
  /* Kit breakpoint.compact-max, layout.rail.seat, and layout.sticky-offset. */
  @media (min-width: 821px) {
    .event-layout { display: grid; grid-template-columns: minmax(0, 1fr) 380px; grid-template-areas: "head rail" "body rail"; column-gap: var(--space-9); align-items: start; }
    .event-layout-rail { position: sticky; top: 92px; }
  }
</style>
