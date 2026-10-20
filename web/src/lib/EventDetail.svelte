<script lang="ts">
import { eventStartInDeviceTimezone } from "../../../assets/event-device-timezone";
import JsonLd from "#lib/JsonLd.svelte";
import Shell from "#lib/Shell.svelte";
import type { KitEventDetailModel } from "../../../src/events/kit-detail";
import { HOME_JOIN_RESULT_COPY } from "../../../src/home-copy";
import {
  EVENT_FULL_TESTID,
  RSVP_BUTTON_ISLAND,
  RSVP_CHECK_TESTID,
  RSVP_CLOSED_TESTID,
  RSVP_CONFIRMED_TESTID,
  RSVP_COPY,
  RSVP_GOING_TESTID,
  RSVP_PAUSED_TESTID,
  RSVP_SYNCED_TESTID,
  RSVP_SYNCING_TESTID,
  RSVP_WITHDRAW_TESTID,
  WAITLIST_CLAIM_TESTID,
  WAITLIST_JOIN_TESTID,
  WAITLIST_LEAVE_TESTID,
  WAITLIST_POSITION_TESTID,
  loginUrl,
  renderGoingCount,
  rsvpClosedCopy,
  rsvpFullCapCopy,
  waitlistPositionCopy,
} from "../../../src/islands/contracts";

// Live event-detail presentation for GET /e/:key (card 25/43). Markup contract
// of EventPage (src/events/pages-detail.tsx): hero, metadata, RSVP, share,
// member-only attendees, discovery. The RSVP block is the served state
// machine as a native form posting to the unchanged Hono controller (the
// mutation stays Hono-owned until card 26/43); the islands only enhance it.
// Attendees render only when the model carries them — the resolver discloses
// them to members alone, so anonymous HTML can never hold member names.
let { model }: { model: KitEventDetailModel } = $props();
let deviceTimezoneText = $state("");
function enableDeviceTimezone(button: HTMLButtonElement) {
  button.hidden = false;
}
// A client-side navigation must not carry the previous event's comparison forward.
$effect(() => {
  model.eventKey;
  model.timeDatetime;
  deviceTimezoneText = "";
});

// A component-level <script> is Svelte's own; the island tags are emitted as
// markup so the existing E2E and islands apply unchanged (past-page pattern).
const rsvpIsland = '<script src="/islands/rsvp-button.js" defer></' + "script>";
const copyLinkIsland = '<script src="/islands/copy-link.js" defer></' + "script>";
const goingCountIsland = '<script src="/islands/going-count.js" defer></' + "script>";
const attendeesLiveIsland = '<script src="/islands/attendees-live.js" defer></' + "script>";

// Server-decided RSVP closure: the resolver settles the verdict from the
// server render instant, so a fast or slow viewer clock never reopens or
// closes this render.
const closed = $derived(model.rsvpClosed);
const occupancy = $derived(model.goingOccupancy);
const full = $derived(model.capacity !== null && occupancy >= model.capacity);
const going = $derived(model.answer?.status === "going");
const waitlisted = $derived(model.answer?.status === "waitlisted");
const signIn = $derived(loginUrl(model.joinReturnTo));
const rsvpAction = $derived(
  model.attendeesPaging.page > 1
    ? `/e/${encodeURIComponent(model.eventKey)}/rsvp?attendees=${model.attendeesPaging.page}`
    : `/e/${encodeURIComponent(model.eventKey)}/rsvp`,
);
const lineup = $derived(
  renderGoingCount(model.eventKey, {
    going: model.goingCount,
    occupancy: model.goingOccupancy,
    capacity: model.capacity,
    showSpotsLeft: true,
    announcement: null,
  }),
);
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
  activeNav="events"
  loginReturnTo={model.path}
  accountChrome={model.viewerUsername ? memberChrome : undefined}
>
  <nav class="event-back" aria-label="Event calendar">
    <a href="/events">← All events</a>
  </nav>
  <section class="event-hero" aria-label="Event overview">
    <p class="event-kicker">{model.game ?? "Community event"}</p>
    {#if model.isDraft}
      <p class="notice" data-testid="event-draft">Draft</p>
    {/if}
    {#if model.isPast}
      <p class="notice" data-testid="event-past">Past event</p>
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
  <dl class="event-meta" aria-label="Event details">
    <div>
      <dt>When</dt>
      <dd>
        <time datetime={model.timeDatetime}>{model.whenText} ({model.zoneLabel})</time>
      </dd>
      <dd class="event-device-timezone">
        <button
          type="button"
          hidden
          use:enableDeviceTimezone
          aria-controls="event-device-timezone-result"
          onclick={() => { deviceTimezoneText = eventStartInDeviceTimezone(model.timeDatetime); }}
        >Show in my device timezone</button>
        <p id="event-device-timezone-result" role="status" aria-live="polite">{deviceTimezoneText}</p>
      </dd>
    </div>
    {#if model.location}
      <div>
        <dt>Where</dt>
        <dd>
          <p data-testid="event-venue">{model.location}</p>
        </dd>
      </div>
    {/if}
    <div>
      <dt>The lineup</dt>
      <dd><p>{@html lineup}</p></dd>
    </div>
  </dl>
  <div class="event-rsvp">
    <section
      data-island={RSVP_BUTTON_ISLAND}
      data-event-key={model.eventKey}
      data-login-url={signIn}
      data-capacity={model.capacity ?? undefined}
      data-full={full ? "true" : "false"}
      data-paused={model.rsvpOpen ? "false" : "true"}
      aria-label="RSVP"
    >
      {#if closed}
        <p role="status" data-testid={RSVP_CLOSED_TESTID}>{rsvpClosedCopy(closed)}</p>
      {:else if !model.viewerMember}
        <a href={signIn}>{RSVP_COPY.guestCta}</a>
      {:else}
        <form method="post" action={rsvpAction} data-rsvp-form>
          {#if !model.rsvpOpen}
            <p role="status" data-testid={RSVP_PAUSED_TESTID}>{RSVP_COPY.paused}</p>
          {/if}
          {#if going}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex: Hono parity — the confirmed notice stays programmatically focusable exactly like the served RSVP button, so the island can move focus to the new state after a write. -->
            <p role="status" tabindex={-1} data-testid={RSVP_CONFIRMED_TESTID}>
              <span aria-hidden="true" data-testid={RSVP_CHECK_TESTID}>✓{" "}</span>{RSVP_COPY.confirmed}
            </p>
            <button type="submit" name="status" value="withdraw" data-testid={RSVP_WITHDRAW_TESTID} data-action="withdraw">{RSVP_COPY.withdraw}</button>
          {:else if waitlisted}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex: Hono parity — the waitlist notice stays programmatically focusable exactly like the served RSVP button, so the island can move focus to the new state after a write. -->
            <p role="status" tabindex={-1} data-testid={WAITLIST_POSITION_TESTID}>
              {waitlistPositionCopy(model.waitlistPosition)}
            </p>
            {#if model.rsvpOpen && !full}
              <button type="submit" name="status" value="going" data-testid={WAITLIST_CLAIM_TESTID} data-action="going">{RSVP_COPY.waitlistClaim}</button>
            {/if}
            <button type="submit" name="status" value="withdraw" data-testid={WAITLIST_LEAVE_TESTID} data-action="withdraw">{RSVP_COPY.waitlistLeave}</button>
          {:else if !model.rsvpOpen}
            <!-- paused with no answer: the notice above is the whole state -->
          {:else if full}
            <p role="status" data-testid={EVENT_FULL_TESTID}>
              {RSVP_COPY.full} {rsvpFullCapCopy(model.capacity!)}
            </p>
            <button type="submit" name="status" value="waitlisted" data-testid={WAITLIST_JOIN_TESTID} data-action="waitlisted">{RSVP_COPY.waitlistJoin}</button>
          {:else}
            <button type="submit" name="status" value="going" data-testid={RSVP_GOING_TESTID} data-action="going">{RSVP_COPY.cta}</button>
          {/if}
          {#if going || waitlisted}
            {#if model.answer?.syncedToDiscordAt}
              <p data-testid={RSVP_SYNCED_TESTID}>{RSVP_COPY.synced}</p>
            {:else}
              <p role="status" data-testid={RSVP_SYNCING_TESTID}>{RSVP_COPY.syncing}</p>
            {/if}
          {/if}
        </form>
      {/if}
    </section>
    {@html rsvpIsland}
  </div>
  <div class="event-detail-grid">
    <div>
      {#if model.description}
        <section class="event-description" aria-labelledby="event-description-heading">
          <h2 id="event-description-heading">About this event</h2>
          <p>{model.description}</p>
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
    <section class="event-share" aria-labelledby="event-share-heading">
      <h2 id="event-share-heading">Save the date</h2>
      <p>
        <a href={model.icsUrl} data-testid="event-ics">Add to calendar (.ics)</a>
        {" · "}
        <a href={model.googleCalendarUrl} data-testid="event-google-calendar" rel="noopener">
          Google Calendar
        </a>
        {" · "}
        <a href={model.copyLink} data-copy-link={model.copyLink} data-testid="event-copy-link">
          Copy link
        </a>
      </p>
      <p role="status" aria-live="polite" data-testid="event-copy-toast" data-copy-toast></p>
    </section>
  </div>
  {#if model.attendees.length > 0 || (model.viewerMember && model.attendeesPaging.page > 1)}
    <section aria-labelledby="event-attendees-heading" data-testid="event-attendees" data-island="attendees-live">
      {#if model.attendeesPaging.prevHref || model.attendeesPaging.nextHref}
        <h2 id="event-attendees-heading">Who's going</h2>
      {:else}
        <h2 id="event-attendees-heading">Who's going ({model.attendees.length})</h2>
      {/if}
      {#if model.attendees.length > 0}
        <ul class="event-attendee-grid">
          {#each model.attendees as attendee (attendee.id)}
            <li>
              <span class="event-attendee-mark" aria-hidden="true">
                {Array.from(attendee.name)[0]}
              </span>
              <a href="/members/{encodeURIComponent(attendee.id)}">{attendee.name}</a>
            </li>
          {/each}
        </ul>
      {:else}
        <p>There are no more attendees on this page.</p>
      {/if}
      {#if model.attendeesPaging.prevHref || model.attendeesPaging.nextHref}
        <nav class="event-attendees-pagination" aria-label="Attendee pages">
          {#if model.attendeesPaging.prevHref}
            <a
              href={model.attendeesPaging.prevHref}
              rel="prev"
              data-testid="event-attendees-prev"
            >
              ← Previous attendees
            </a>
          {/if}{" "}
          <span data-testid="event-attendees-current-page" aria-current="page">
            Page {model.attendeesPaging.page}
          </span>{" "}
          {#if model.attendeesPaging.nextHref}
            <a
              href={model.attendeesPaging.nextHref}
              rel="next"
              data-testid="event-attendees-next"
            >
              Next attendees →
            </a>
          {/if}
        </nav>
      {/if}
      <p>
        Attendees shown at page load.{" "}
        <a href={model.attendeesRefreshHref} data-testid="event-attendees-refresh">Refresh attendees</a>.
      </p>
    </section>
  {/if}
  {@html copyLinkIsland}
  {@html goingCountIsland}
  {@html attendeesLiveIsland}
  <JsonLd testid="event-jsonld" json={model.jsonLd} />
  <JsonLd testid="site-jsonld" json={model.siteJsonLd} />
  <div class="event-discovery">
    {#if model.neighbors.previous || model.neighbors.next}
      <nav class="event-pagination" aria-label="More events" data-testid="event-pagination">
        {#if model.neighbors.previous}
          <a
            href="/e/{model.neighbors.previous.key}"
            rel="prev"
            data-testid="event-previous"
          >
            ← Previous event: {model.neighbors.previous.title}
          </a>
        {/if}{" "}
        {#if model.neighbors.next}
          <a href="/e/{model.neighbors.next.key}" rel="next" data-testid="event-next">
            Next event: {model.neighbors.next.title} →
          </a>
        {/if}
      </nav>
    {/if}
    {#if model.related.length > 0}
      <section aria-label="Related events" data-testid="event-related">
        <h2>More events you might like</h2>
        <ul class="event-related-grid">
          {#each model.related as event (event.key)}
            <li>
              <a href="/e/{event.key}" data-testid="event-related-link">
                {event.title}{" "}
                <time datetime={event.datetime}>{event.whenText}</time>
                {#if event.location}
                  {" "}<span class="event-related-location">{event.location}</span>
                {/if}
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
</Shell>
