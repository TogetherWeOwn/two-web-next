<script lang="ts">
import JsonLd from "#lib/JsonLd.svelte";
import Shell from "#lib/Shell.svelte";
import type { KitEventDetailModel } from "../../../src/events/kit-detail";
import { HOME_JOIN_RESULT_COPY } from "../../../src/home-copy";
import {
  EVENT_FULL_TESTID,
  RSVP_BUTTON_ISLAND,
  RSVP_CHECK_TESTID,
  RSVP_CLOSED_TESTID,
  RSVP_CONFIRMED_COPY,
  RSVP_CONFIRMED_TESTID,
  RSVP_CTA_COPY,
  RSVP_FULL_COPY,
  RSVP_GOING_TESTID,
  RSVP_GUEST_CTA_COPY,
  RSVP_MAYBE_COPY,
  RSVP_MAYBE_TESTID,
  RSVP_NOT_GOING_COPY,
  RSVP_NOT_GOING_TESTID,
  RSVP_PAUSED_COPY,
  RSVP_PAUSED_TESTID,
  RSVP_SYNCED_COPY,
  RSVP_SYNCED_TESTID,
  RSVP_SYNCING_COPY,
  RSVP_SYNCING_TESTID,
  RSVP_WAITLIST_CLAIM_COPY,
  RSVP_WAITLIST_JOIN_COPY,
  RSVP_WAITLIST_LEAVE_COPY,
  RSVP_WITHDRAW_COPY,
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

// Server-decided RSVP closure: the resolver settles the verdict from the
// server render instant, so a fast or slow viewer clock never reopens or
// closes this render.
const closed = $derived(model.rsvpClosed);
const full = $derived(model.capacity !== null && model.goingOccupancy >= model.capacity);
const going = $derived(model.answer?.status === "going");
const waitlisted = $derived(model.answer?.status === "waitlisted");
const isMaybe = $derived(model.answer?.status === "maybe");
const soft = $derived(isMaybe || model.answer?.status === "not_going");
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
    // Use the server's RSVP verdict for elapsed published rows too: status
    // reconciliation can lag behind the event's end. Draft previews keep
    // their spots line; the browser clock never decides closure.
    showSpotsLeft: model.status !== "past" && model.status !== "cancelled" && closed !== "past",
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

{#snippet rsvpButton(status: "going" | "waitlisted" | "withdraw", testid: string, label: string)}
  <button type="submit" name="status" value={status} data-testid={testid} data-action={status}>{label}</button>
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
      <dt>Starts</dt>
      <dd>
        <time datetime={model.timeDatetime}>{model.whenText} ({model.zoneLabel})</time>
      </dd>
      <dd class="event-device-timezone" data-event-device-timezone>
        <button type="button" hidden data-testid="event-device-timezone-starts-button">Show in my device timezone</button>
        <p role="status" aria-live="polite" data-testid="event-device-timezone-starts-status"></p>
      </dd>
    </div>
    <div>
      <dt>Ends</dt>
      <dd>
        <time datetime={model.endsAt}>{model.endsWhenText} ({model.zoneLabel})</time>
      </dd>
      <dd class="event-device-timezone" data-event-device-timezone>
        <button type="button" hidden data-testid="event-device-timezone-ends-button">Show in my device timezone</button>
        <p role="status" aria-live="polite" data-testid="event-device-timezone-ends-status"></p>
      </dd>
    </div>
    {#if !model.isDraft}
      <div hidden>
        <dt>Time from now</dt>
        <dd
          class="event-device-timezone"
          data-event-time-from-now
          data-starts-at={model.timeDatetime}
          data-ends-at={model.endsAt}
        >
          <button type="button" hidden data-testid="event-time-from-now-button">Show time from now</button>
          <p role="status" aria-live="polite" data-testid="event-time-from-now-status"></p>
        </dd>
      </div>
    {/if}
    {#if model.durationText}
      <div>
        <dt>Duration</dt>
        <dd>{model.durationText}</dd>
      </div>
    {/if}
    <div>
      <dt>Where</dt>
      <dd>
        {#if model.location}
          <p data-testid="event-venue">{model.location}</p>
          {#if model.directionsUrl}
            <p>
              <a href={model.directionsUrl} data-testid="event-directions" rel="noopener">
                Get directions
              </a>
            </p>
          {/if}
        {:else}
          <p data-testid="event-venue-tbd">
            Venue TBD — check <a href="/discord">Discord</a> for updates.
          </p>
        {/if}
      </dd>
    </div>
    {#if model.series && model.series.hosts.length > 0}
      <div>
        <dt>Series hosts</dt>
        <dd>
          <p data-testid="event-series-hosts">{model.series.hosts.join(", ")}</p>
        </dd>
      </div>
    {/if}
    <div>
      <dt>The lineup</dt>
      <dd><p>{@html lineup}</p></dd>
    </div>
    <div hidden>
      <dt>Compare in another timezone</dt>
      <dd class="event-device-timezone" data-event-chosen-timezone>
        <label for="chosen-timezone-input">Timezone (IANA identifier)</label>
        <input
          type="text"
          id="chosen-timezone-input"
          data-testid="event-chosen-timezone-input"
          maxlength="64"
          hidden
          autocomplete="off"
          spellcheck="false"
        />
        <p data-testid="event-chosen-timezone-examples">e.g. Europe/London, Asia/Tokyo</p>
        <button type="button" hidden data-testid="event-chosen-timezone-button">Compare times</button>
        <p role="status" aria-live="polite" data-testid="event-chosen-timezone-status"></p>
      </dd>
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
        <a href={signIn}>{RSVP_GUEST_CTA_COPY}</a>
      {:else}
        <form method="post" action={rsvpAction} data-rsvp-form>
          {#if !model.rsvpOpen}
            <p role="status" data-testid={RSVP_PAUSED_TESTID}>{RSVP_PAUSED_COPY}</p>
          {/if}
          {#if going}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex: Hono parity — the confirmed notice stays programmatically focusable exactly like the served RSVP button, so the island can move focus to the new state after a write. -->
            <p role="status" tabindex={-1} data-testid={RSVP_CONFIRMED_TESTID}>
              <span aria-hidden="true" data-testid={RSVP_CHECK_TESTID}>✓{" "}</span>{RSVP_CONFIRMED_COPY}
            </p>
            {@render rsvpButton("withdraw", RSVP_WITHDRAW_TESTID, RSVP_WITHDRAW_COPY)}
          {:else if waitlisted}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex: Hono parity — the waitlist notice stays programmatically focusable exactly like the served RSVP button, so the island can move focus to the new state after a write. -->
            <p role="status" tabindex={-1} data-testid={WAITLIST_POSITION_TESTID}>
              {waitlistPositionCopy(model.waitlistPosition)}
            </p>
            {#if model.rsvpOpen && !full}
              {@render rsvpButton("going", WAITLIST_CLAIM_TESTID, RSVP_WAITLIST_CLAIM_COPY)}
            {/if}
            {@render rsvpButton("withdraw", WAITLIST_LEAVE_TESTID, RSVP_WAITLIST_LEAVE_COPY)}
          {:else if soft}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex: Hono parity — the soft-answer notice stays programmatically focusable exactly like the served RSVP button, so the island can move focus to the new state after a write. -->
            <p role="status" tabindex={-1} data-testid={isMaybe ? RSVP_MAYBE_TESTID : RSVP_NOT_GOING_TESTID}>
              {isMaybe ? RSVP_MAYBE_COPY : RSVP_NOT_GOING_COPY}
            </p>
            {#if !model.rsvpOpen}
              {@render rsvpButton("withdraw", RSVP_WITHDRAW_TESTID, RSVP_WITHDRAW_COPY)}
            {:else if full}
              {@render rsvpButton("waitlisted", WAITLIST_JOIN_TESTID, RSVP_WAITLIST_JOIN_COPY)}
              {@render rsvpButton("withdraw", RSVP_WITHDRAW_TESTID, RSVP_WITHDRAW_COPY)}
            {:else}
              {@render rsvpButton("going", RSVP_GOING_TESTID, RSVP_CTA_COPY)}
              {@render rsvpButton("withdraw", RSVP_WITHDRAW_TESTID, RSVP_WITHDRAW_COPY)}
            {/if}
          {:else if !model.rsvpOpen}
            <!-- paused with no answer: the notice above is the whole state -->
          {:else if full}
            <p role="status" data-testid={EVENT_FULL_TESTID}>
              {RSVP_FULL_COPY} {rsvpFullCapCopy(model.capacity!)}
            </p>
            {@render rsvpButton("waitlisted", WAITLIST_JOIN_TESTID, RSVP_WAITLIST_JOIN_COPY)}
          {:else}
            {@render rsvpButton("going", RSVP_GOING_TESTID, RSVP_CTA_COPY)}
          {/if}
          {#if going || waitlisted}
            {#if model.answer?.syncedToDiscordAt}
              <p data-testid={RSVP_SYNCED_TESTID}>{RSVP_SYNCED_COPY}</p>
            {:else}
              <p role="status" data-testid={RSVP_SYNCING_TESTID}>{RSVP_SYNCING_COPY}</p>
            {/if}
          {/if}
        </form>
      {/if}
    </section>
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
        {#if model.googleCalendarUrl}
          {" · "}
          <a href={model.googleCalendarUrl} data-testid="event-google-calendar" rel="noopener">
            Google Calendar
          </a>
        {/if}
        {" · "}
        <a href={model.copyLink} data-copy-link={model.copyLink} data-testid="event-copy-link">
          Copy link
        </a>
        {#if model.status === "published"}<span hidden data-native-share-sep aria-hidden="true">{" · "}</span><button
            type="button"
            hidden
            data-native-share
            data-share-title={model.title}
            data-share-url={model.canonical}
            data-testid="event-share"
          >
            Share
          </button>
        {/if}
      </p>
      <p role="status" aria-live="polite" data-testid="event-copy-toast" data-copy-toast></p>
      {#if model.status === "published"}
        <p
          role="status"
          aria-live="polite"
          data-testid="event-share-status"
          data-native-share-status
        ></p>
      {/if}
    </section>
  </div>
  {#if model.attendees.length > 0 || (model.viewerMember && model.attendeesPaging.page > 1)}
    <section aria-labelledby="event-attendees-heading" data-testid="event-attendees" data-island="attendees-live">
      <h2 id="event-attendees-heading">Who's going{model.attendeesPaging.prevHref || model.attendeesPaging.nextHref ? "" : ` (${model.attendees.length})`}</h2>
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
  {:else}
    <!-- One shell keeps the named roster states consistent without duplicating
         markup in the client bundle. The resolver's viewer state, not username,
         distinguishes a guest from a signed-in non-member. -->
    <section
      aria-labelledby="event-roster-heading"
      data-testid={model.viewerMember ? "event-roster-empty" : model.showJoinPitch ? "event-roster-guest-nudge" : "event-roster-members-only"}
    >
      <h2 id="event-roster-heading">Who's going{model.viewerMember ? " (0)" : ""}</h2>
      <p>
        {#if model.viewerMember}
          No one is listed as going yet.
        {:else if model.showJoinPitch}
          {model.goingCount > 0 ? `${model.goingCount} going —` : "No one is listed as going yet."}
          <a href={signIn}>sign in to see who's in</a>.
        {:else}
          Members only —
          <a href="/join?next={encodeURIComponent(model.joinReturnTo)}">join the Discord</a>
          to see who's in.
        {/if}
      </p>
    </section>
  {/if}
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
</Shell>
