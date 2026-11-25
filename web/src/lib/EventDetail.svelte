<script lang="ts">
import EventVoicePlacement from "#lib/EventVoicePlacement.svelte";
import JsonLd from "#lib/JsonLd.svelte";
import Lifeline from "#lib/Lifeline.svelte";
import Shell from "#lib/Shell.svelte";
import Tag from "#lib/Tag.svelte";
import TimeBlock from "#lib/TimeBlock.svelte";
import type { KitEventDetailModel } from "../../../src/events/kit-detail";
import { kitEventFacts } from "../../../src/events/kit-event-facts";
import {
  kitOpenSeat,
  kitSeatActionBar,
  KIT_SIGNUPS_OPEN,
} from "../../../src/events/kit-seat-actions";
import { isPublicJoinUrl } from "../../../src/events/public-join-url";
import { HOME_JOIN_RESULT_COPY } from "../../../src/home-copy";
import {
  EVENT_ONGOING_TESTID,
  RSVP_COPY,
  RSVP_SYNCED_TESTID,
  RSVP_SYNCING_TESTID,
} from "../../../src/islands/contracts";
import { listedSignUpCountText } from "../../../src/islands/contracts-going-count";
import type { LifelineStep } from "./lifeline";

// Member metadata, RSVP and roster are escaped server leaves shared with Hono.
// Mutation ownership and native island mounts stay unchanged; this route is csr=false.
let {
  model,
  restoredWrite = false,
  lifeline,
  publicVoiceEnabled = false,
}: {
  model: KitEventDetailModel;
  restoredWrite?: boolean;
  /** Composed server presentation. */
  lifeline?: readonly LifelineStep[];
  publicVoiceEnabled?: boolean;
} = $props();
const facts = $derived(kitEventFacts(model));
const lifecycle = $derived(model.lifecycle);
const live = $derived(model.liveTime);
const savedLive = $derived(
  live && !model.review && model.viewerMember && model.answer?.status === "going",
);
const openSeat = $derived(kitOpenSeat(model));
const seatHeading = $derived(openSeat ?? model.seatCard.heading);
const bar = $derived(kitSeatActionBar(model));

// A component-level <script> is Svelte's own; the island tags are emitted as
// markup so the existing E2E and islands apply unchanged (past-page pattern).
// This route is csr=false. Share one native-island block in execution order;
// every deferred script runs after parsing, with all of its mount nodes present.
const detailIslands = $derived([
  live ? "kit-live-event-time" : "event-device-timezone",
  ...(live ? [] : ["event-time-from-now"]),
  "rsvp-button",
  "copy-link",
  "event-share",
  "going-count",
  "attendees-live",
  ...(publicVoiceEnabled ? ["kit-public-voice"] : []),
]);
</script>

{#snippet liveTag(testid?: string)}
  <span data-live-fresh data-testid={testid}><Tag variant="live">Live</Tag></span>
  <span hidden data-live-stale><Tag variant="warn">Stale</Tag></span>
{/snippet}

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
  mainClass="kit-event-detail"
  activeNav="event"
  member={model.viewerMember}
  authenticated={model.viewerAuthenticated}
  loginReturnTo={model.path}
  accountChrome={model.viewerUsername ? memberChrome : undefined}
>
  <div class="event-layout" class:live-action={!!live && !savedLive && !model.review}
    id={live ? "kit-live-snapshot" : undefined} data-as-of={live?.asOf} data-stale-at={live?.staleAt}>
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
    {#if !model.isEnded && model.isPast}
      <p class="notice" data-testid="event-past">Past event</p>
    {/if}
    {#if model.status === "cancelled"}
      <p class="notice" role="status" data-testid="event-cancelled">Cancelled</p>
    {/if}
    {#if live}
      <div class="lifecycle-tags">
        {@render liveTag(EVENT_ONGOING_TESTID)}
        {#if savedLive}<Tag variant="you">You're in</Tag>{/if}
      </div>
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
  {#if lifecycle}
    <div class="lifecycle-time" data-testid="kit-event-time">
      <time class="lifecycle-figure" datetime={model.timeDatetime}>{lifecycle.date}</time>
      <p>Ended <time datetime={model.endsAt}>{lifecycle.endTime}</time> · {model.zoneLabel}</p>
    </div>
  {:else if live}
    <div class="live-time" data-testid="kit-event-time">
      <TimeBlock start={new Date(model.timeDatetime)} end={new Date(model.endsAt)} asOf={new Date(live.asOf)}
        state="live" stale={false} viewerZone={model.zoneLabel} serverLive />
    </div>
  {:else}
    {@html model.detailHtml.metadata}
  {/if}
  </div>
  <div class="event-layout-rail">
    {#if model.isEnded}
      {@const echoNote = lifeline?.some((step) => step.id === "echo") ? "" : "No Echo for this one. "}
      <section class="seat-card" aria-labelledby="signup-record-heading" data-testid="event-past">
        <div class="seat-card-head"><h2 id="signup-record-heading">Sign-up record</h2></div>
        <p class="seat-card-note">{`${echoNote}${listedSignUpCountText(model.goingCount)}.`}</p>
        {#if model.endedNext}<p><a href="/e/{model.endedNext.key}">Next one: {model.endedNext.date}</a></p>{/if}
      </section>
      {#if model.viewerModerator && model.review}{@html model.review.rsvp}{/if}
    {:else if savedLive}
      <section class="seat-card" aria-labelledby="seat-card-heading" data-testid="kit-seat-card">
        <div class="seat-card-head"><h2 id="seat-card-heading">You're in.</h2>{@render liveTag()}</div>
        {#if model.answer?.syncedToDiscordAt}
          <p class="seat-card-note" data-testid={RSVP_SYNCED_TESTID}>{RSVP_COPY.synced}</p>
        {:else}
          <p class="seat-card-note" role="status" data-testid={RSVP_SYNCING_TESTID}>{RSVP_COPY.syncing}</p>
        {/if}
      </section>
    {:else}
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
    {/if}
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
    <EventVoicePlacement enabled={publicVoiceEnabled} eventKey={model.eventKey} publicLive />
    {@html model.detailHtml.share}
  </div>
  <div class="event-layout-body" class:ended={Boolean(lifecycle)}>
  {#if lifecycle || live}{@html model.detailHtml.metadata}{/if}
  {#if lifeline?.length}<Lifeline steps={lifeline} zone={model.zoneLabel} />{/if}
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
  {@html detailIslands.map((name) => `<script src="/islands/${name}.js" defer></` + "script>").join("")}
  <JsonLd testid="event-jsonld" json={model.jsonLd} />
  <JsonLd testid="site-jsonld" json={model.siteJsonLd} />
  <div class="event-discovery">{@render eventPagination(model.series, true)}{@render eventPagination(model.neighbors, false)}
    {#if model.related.length > 0}
      <section aria-label="Related events" data-testid="event-related">
        <h2 id="event-related-heading">More events you might like</h2>
        <ul class="event-related-grid" role="list" aria-labelledby="event-related-heading">
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
  {#if bar}
    <aside class="event-seat-bar" aria-label="Your seat" data-state={bar.state}>
      <p><strong>{bar.title}</strong><br />{bar.detail}</p>
      <a class="seat-action seat-action-icon" href={model.icsUrl} aria-label="Add to calendar">
        <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round">
          <rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>
        </svg>
      </a>
      {#if bar.state === "open"}
        <form method="post" action={bar.action}>
          <button class="seat-action seat-action-primary" type="submit" name="status" value="going">{RSVP_COPY.cta}</button>
        </form>
      {:else if bar.state === "guest"}
        <a class="seat-action seat-action-primary" href={bar.href}>{bar.label}</a>
      {/if}
    </aside>
  {/if}
</Shell>
