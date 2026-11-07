<script lang="ts">
import JsonLd from "#lib/JsonLd.svelte";
import Shell from "#lib/Shell.svelte";
import type { KitEventDetailModel } from "../../../src/events/kit-detail";
import { ONGOING_COPY } from "../../../src/events/ongoing";
import { isPublicJoinUrl } from "../../../src/events/public-join-url";
import { HOME_JOIN_RESULT_COPY } from "../../../src/home-copy";
import { EVENT_ONGOING_TESTID } from "../../../src/islands/contracts";

// Member metadata, RSVP and roster are escaped server leaves shared with Hono.
// Mutation ownership and native island mounts stay unchanged; this route is csr=false.
let { model }: { model: KitEventDetailModel } = $props();

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
  <nav class="event-back" aria-label="Event calendar">
    <a href={model.archiveReturn?.href ?? "/events"}>{model.archiveReturn?.label ?? "← All events"}</a>
  </nav>
  {#if model.viewerModerator && model.review}{@html model.review.banner}{/if}
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
  <div class="event-rsvp">
    {@html model.detailHtml.rsvp}
  </div>
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
    {@html model.detailHtml.share}
  </div>
  {@html model.detailHtml.roster}
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
