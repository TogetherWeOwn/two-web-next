<script lang="ts">
import "./home-presentation.css";
import "./home-ember.css";
import Button from "#lib/Button.svelte";
import EmberFooter from "#lib/EmberFooter.svelte";
import JsonLd from "#lib/JsonLd.svelte";
import LiveSentence from "#lib/LiveSentence.svelte";
import SiteMetadata from "#lib/SiteMetadata.svelte";
import VoicePanel from "#lib/VoicePanel.svelte";
import type { VoiceView } from "#lib/voice-view.ts";
import { seatAvailability } from "../../../src/events/pages-calendar-row";
import type { HomeUpcomingRow } from "../../../src/events/reads";
import { groupTeaserEvents } from "../../../src/events/teaser-groups";
import { featuredImageSrc } from "../../../src/featured-image";
import type { HomeNotice } from "../../../src/home-copy";
import {
  SPOTS_LEFT_TESTID,
  cardTimeLabel,
  goingAnnouncementText,
  goingCountText,
  isValidZone,
} from "../../../src/islands/contracts";
import { canonicalUrl } from "../../../src/seo";
import { siteJsonLd } from "../../../src/seo-json-ld";
import type { PageProps } from "./$types";
import HomeGuestIntro from "./HomeGuestIntro.svelte";
import "./home-join-band.css";

const publicVoiceIsland = '<script src="/islands/kit-public-voice.js" defer></' + "script>";

// Kit passes only its usual page props. The offline render fixture passes
// an audience projection separately; the shipped load never produces one.
let { data, voice }: PageProps & { voice?: VoiceView } = $props();
const {
  session,
  sessionUnavailable,
  notice,
  joinResult,
  inviteUrl,
  appUrl,
  counts,
  countsSnapshot,
  upcomingEvents,
  eventsUnavailable,
  featured,
  imageHosts,
} = $derived(data);
const { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO } = $derived(data.homeCopy);
const canonical = $derived(canonicalUrl(appUrl, "/"));
// The load validates ?n= through parseHomeNotice, so by render time the key
// is one of the six — the cast only recovers what $derived destructuring widens.
const noticeText = $derived(notice ? HOME_NOTICES[notice as HomeNotice] : null);
const ranks = $derived(counts.ranks.length ? counts.ranks : FALLBACK_RANKS);
const siteGraph = $derived(siteJsonLd(appUrl));
// Same shared buckets as the Hono screen: group the capped rows at render.
// The explicit row type recovers what $derived destructuring widens (see
// noticeText above): without it the groups widen to the helper's input.
const renderTime = $derived(new Date(data.nowMs));
const groupedEvents = $derived(groupTeaserEvents<HomeUpcomingRow>(upcomingEvents, renderTime));
const weekEvents = $derived(
  upcomingEvents.filter(
    (event: HomeUpcomingRow) =>
      event.startsAt >= renderTime &&
      groupedEvents.some((group) => group.key !== "later" && group.events.includes(event)),
  ),
);
const showMemberDetails = $derived(session?.member && !sessionUnavailable);
function ownRsvp(event: HomeUpcomingRow) {
  if (!showMemberDetails || event.source !== "canonical") return null;
  const status = data.memberRsvps?.find((rsvp) => rsvp.eventKey === event.eventKey)?.status;
  return status === "going" || status === "waitlisted" ? status : null;
}
const nextOwnEvent = $derived(
  session?.member
    ? (upcomingEvents as HomeUpcomingRow[])
        .flatMap((event) => {
          if (event.source !== "canonical" || event.startsAt <= renderTime) return [];
          const answer = data.memberRsvps?.find((rsvp) => rsvp.eventKey === event.eventKey);
          if (answer?.status !== "going" && answer?.status !== "waitlisted") return [];
          return [{ event, status: answer.status as "going" | "waitlisted" }];
        })
        .sort((a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime())[0]
    : undefined,
);
const heroRsvp = $derived(!sessionUnavailable && !eventsUnavailable ? nextOwnEvent : undefined);
const nextPublicEvent = $derived(
  upcomingEvents.find((event: HomeUpcomingRow) => event.startsAt > renderTime),
);
const heroEvent = $derived(eventsUnavailable ? undefined : (heroRsvp?.event ?? nextPublicEvent));
const voiceAudience = $derived(session?.member ? "member" : "guest");
const homeVoice = $derived(
  !sessionUnavailable && voice?.snapshot && voice.audience === voiceAudience ? voice : undefined,
);
const nextVoiceEvent = $derived.by(() => {
  if (eventsUnavailable) return undefined;
  if (!nextPublicEvent) return null;
  const { title, startsAt, timezone } = nextPublicEvent;
  return {
    title,
    timeLabel: `${cardTimeLabel(startsAt, timezone)} (${isValidZone(timezone) ? timezone : "UTC"})`,
  };
});
</script>

{#snippet primaryLinks()}
  <nav aria-label="Primary">
    <a href="/events">Events</a>
    {#if session?.member}<a href="/leaderboards/members">Leaderboard</a>{/if}
    <a href="/about">About</a>
  </nav>
{/snippet}

{#snippet teaserTime(event: HomeUpcomingRow)}
  <time datetime={event.startsAt.toISOString()}>{cardTimeLabel(event.startsAt, event.timezone)} ({isValidZone(event.timezone) ? event.timezone : "UTC"})</time>
{/snippet}

{#snippet schedulePanel()}
  <aside class="ember-home-panel" aria-labelledby="home-panel-heading">
    <h2 id="home-panel-heading">{heroRsvp ? "Your RSVP" : "On the schedule"}</h2>
    {#if heroEvent}
      <p><strong>{heroEvent.title}</strong></p>
      <p><time datetime={heroEvent.startsAt.toISOString()}>{cardTimeLabel(heroEvent.startsAt, heroEvent.timezone)} ({isValidZone(heroEvent.timezone) ? heroEvent.timezone : "UTC"})</time></p>
      {#if heroRsvp}<p>{goingAnnouncementText(heroRsvp.status)}</p>{/if}
      {#if heroEvent.source === "discord"}<a href={inviteUrl}>Open Discord</a>
      {:else}<a href={`/e/${encodeURIComponent(heroEvent.eventKey)}`}>View event details</a>{/if}
    {:else}
      <p><strong>{eventsUnavailable ? "Schedule unavailable" : "No upcoming game nights"}</strong></p>
      <a href="/discord">Find us on Discord</a>
    {/if}
  </aside>
{/snippet}

{#snippet homeContent()}
  {#if joinResult}
    <p class="notice" role="status" data-testid="join-result">
      {#if joinResult === "added"}
        {HOME_JOIN_RESULT_COPY.added}
      {:else}
        {HOME_JOIN_RESULT_COPY.alreadyInServer}
        {" "}<a href="/discord" data-testid="reinvite-link">{HOME_JOIN_RESULT_COPY.reinvite}</a>
      {/if}
    </p>
  {:else if noticeText}
    <p class="notice" role="status" data-testid="notice">{noticeText}</p>
    {#if notice === "signin_failed" || notice === "signin_denied" || notice === "signin_unavailable"}
      <p>
        <a href="/auth/discord" data-testid="notice-retry">Try signing in again</a>
      </p>
    {/if}
  {/if}
  <section class="hero kit-home" aria-labelledby="home-heading">
    <div>
      <p class="strap">A close-knit gaming clan / mostly evenings / 18+</p>
      {#if homeVoice}
        <LiveSentence view={homeVoice} nextEvent={nextVoiceEvent} headingId="home-heading" showActions={false} />
      {:else}
        <h1 id="home-heading">
          {#if !eventsUnavailable && nextPublicEvent}
            Next game night: <em>{nextPublicEvent.title}</em>. <span>Come play with us.</span>
          {:else}
            The lobby is <em>open</em>.
          {/if}
        </h1>
      {/if}
      <div class="hero-action">
        {#if sessionUnavailable}
          <a class="btn" href="/discord" data-testid="discord-join">Join with an invite link</a>
          <p class="lead">Sign-in is unavailable right now. The invite still works.</p>
        {:else if session?.member}
          <a id="discord-heading" class="btn" href={inviteUrl}>Open Discord</a>
          <p class="lead">Catch up with the clan in Discord.</p>
        {:else}
          <a class="btn" href="/auth/discord" data-testid="join">Join with Discord</a>
          <p class="lead">{session ? "You're signed in. Join the server to play with us." : "We spent most of our life private. Now you can just turn up."}</p>
        {/if}
      </div>
      {#if !session && !sessionUnavailable && eventsUnavailable}
        <p><a href="/discord" data-testid="discord-join">Join with an invite link instead</a></p>
      {/if}
      {#if notice === "join_failed"}
        <p><a href={inviteUrl}>Join with an invite link instead</a></p>
      {/if}
      {#if countsSnapshot}
        <p class="counts" data-testid="member-count" data-stale={countsSnapshot.stale}>
          <strong>{countsSnapshot.memberCount}</strong> members{#if countsSnapshot.onlineCount != null}
            {" · "}<strong>{countsSnapshot.onlineCount}</strong> online{/if}
          {#if countsSnapshot.stale}
            {" · Last seen "}<time datetime={countsSnapshot.observedAt}>{countsSnapshot.observedAt.replace("T", " ").replace("Z", " UTC")}</time>
          {/if}
        </p>
      {/if}
      {#if data.publicVoiceEnabled}
        <p class="counts" id="home-public-voice">Voice numbers are not available right now.</p>
        {@html publicVoiceIsland}
      {/if}
    </div>
    {#if homeVoice}
      <div class="home-voice-panels">
        <VoicePanel view={homeVoice} />
        {@render schedulePanel()}
      </div>
    {:else}
      {@render schedulePanel()}
    {/if}
  </section>
  {@render homeBelowHero()}
{/snippet}

{#snippet homeFeatured()}
  {#if featured.length > 0}
    <section aria-labelledby="featured-heading" data-testid="featured-content">
      <h2 id="featured-heading">From the community team</h2>
      <div class="facts">
        {#each featured as item (item.id)}
          {@const src = item.imageUrl ? featuredImageSrc(item.imageUrl, appUrl, imageHosts) : null}
          <article class="card" data-testid="featured-item">
            <h3>{#if item.url}<a href={item.url}>{item.title}</a>{:else}{item.title}{/if}</h3>
            {#if item.body}<p>{item.body}</p>{/if}
            {#if src}
              <img
                class="featured-image"
                {src}
                alt={item.imageAlt?.trim() || item.title}
                width="640"
                height="360"
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
              />
            {/if}
          </article>
        {/each}
      </div>
    </section>
  {/if}
{/snippet}

{#snippet homeLadder()}
  <section aria-label="Community ladder" class="community-ladder">
    <h2>Prospect → Member → Soldier → Veteran → Legend</h2>
    <p>Ranks stack — a Veteran still holds everything below.</p>
    <dl class="facts rank-stack" data-testid="rank-stack">
      {#each ranks as rank (rank.key)}
        <div class="card" data-rank={rank.key}>
          <dt>{rank.label}</dt>
          <dd>{rank.memberCount === 0 ? "unclaimed" : rank.memberCount}</dd>
        </div>
      {/each}
    </dl>
  </section>
{/snippet}

{#snippet homeBelowHero()}
  {#if !session?.member}<HomeGuestIntro />{/if}
  <section class="week-band" aria-labelledby="home-week-heading">
    <div class="band-head">
      <h2 id="home-week-heading">{showMemberDetails ? "Your week," : "This week,"} <span>when we play.</span></h2>
      <p>
        Times are shown in each event’s time zone.
        {#if showMemberDetails}Your RSVPs are marked in the agenda.{/if}
      </p>
    </div>
    <div class="week-panel">
      {#if eventsUnavailable}
        <p>We couldn’t load this week’s schedule.</p>
      {:else if weekEvents.length > 0}
        <ul class="week-agenda" role="list">
          {#each weekEvents as event (event.source === "discord" ? `discord-${event.discordId}` : `canonical-${event.eventKey}`)}
            {@const status = ownRsvp(event)}
            <li>
              {@render teaserTime(event)}
              <div>
                <strong>{event.title}</strong>
                {#if status}<span class="schedule-rsvp">{goingAnnouncementText(status)}</span>{/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p>No new starts in this preview. <a href="/events">See all events</a></p>
      {/if}
    </div>
  </section>
  <section class="event-band" aria-labelledby="home-events-heading">
    <div class="band-head">
      <h2 id="home-events-heading">What’s on. <span>{showMemberDetails ? "Plan your next game." : "Come along."}</span></h2>
      <p>Browse upcoming game nights. Open an event for the details or head to Discord for events hosted there.</p>
    </div>
    {#if !eventsUnavailable && upcomingEvents.length > 0}
      <ul class="facts home-events" role="list" data-testid="home-events-list">
        <!-- Exclude the server-rendered list from the unused client asset. -->
        {#if import.meta.env?.SSR !== false}
          {#each groupedEvents as group (group.key)}
            <li class="home-events-group" data-testid={"home-events-group-" + group.key}>
              <h3 class="strap">{group.label}</h3>
              <ul class="schedule-rows" role="list">
                {#each group.events as event (event.source === "discord" ? `discord-${event.discordId}` : `canonical-${event.eventKey}`)}
                  {@const status = ownRsvp(event)}
                  <li class="card" data-source={event.source}>
                    <a
                      class="home-event-link"
                      href={event.source === "discord" ? inviteUrl : `/e/${encodeURIComponent(event.eventKey)}`}
                      data-testid={event.source === "discord" ? "home-event-discord" : undefined}
                    >
                      {@render teaserTime(event)}
                      <div class="event-meta">
                        <h4>{event.title}</h4>
                        {#if event.source === "canonical" && event.game?.trim()}<p>{event.game.trim()}</p>{/if}
                        {#if showMemberDetails && event.source === "canonical" && event.organizer_name?.trim()}
                          <p class="home-event-host" data-testid="event-card-host">Hosted by {event.organizer_name.trim()}</p>
                        {/if}
                        {#if event.location}<p>{event.location}</p>{/if}
                        {#if status}
                          <p data-testid="home-event-own-rsvp"><span class="schedule-rsvp">{goingAnnouncementText(status)}</span></p>
                        {/if}
                      </div>
                      {#if event.source === "discord"}
                        <p>RSVP in Discord · <span data-testid="event-schedule-availability">Discord-managed</span></p>
                      {:else}
                        {@const availability = event.endsAt && event.endsAt.getTime() <= renderTime.getTime()
                          ? { state: "past", text: "Ended" }
                          : seatAvailability(event)}
                        <p>
                          {goingCountText(event.goingCount, event.capacity)}{" · "}
                          <span data-testid={availability.state === "full" ? SPOTS_LEFT_TESTID : "event-schedule-availability"}>{availability.text}</span>
                        </p>
                      {/if}
                      <span class="schedule-action">{event.source === "discord" ? "Open Discord" : "Details"}</span>
                    </a>
                  </li>
                {/each}
              </ul>
            </li>
          {/each}
        {/if}
      </ul>
      <p>
        <a href="/events">See all events <span aria-hidden="true">→</span></a>
      </p>
    {:else}
      <div
        class="card"
        data-testid="home-events-empty"
        data-state={eventsUnavailable ? "unavailable" : "empty"}
      >
        <h3>
          {#if eventsUnavailable}
            Game nights are unavailable right now.
          {:else}
            Nothing scheduled yet.
          {/if}
        </h3>
        <p>
          {#if eventsUnavailable}
            We couldn’t load the schedule.
            <a href="/discord" data-testid="home-events-empty-link">The Discord</a>
            is still open — check there for the next game night.
          {:else}
            Game nights get posted here.
            <a href="/join" data-testid="home-events-empty-link">Join the Discord</a>
            and you’ll hear about the next one.
          {/if}
        </p>
        {#if !eventsUnavailable}
          <p><a href="/discord" data-testid="home-suggest-event">Suggest an event in Discord</a></p>
        {/if}
      </div>
    {/if}
    {#if !session}
      <p>
        <a href="/join" data-testid="home-events-join">
          Join the Discord <span aria-hidden="true">→</span>
        </a>
      </p>
    {/if}
  </section>
  {@render homeFeatured()}
  {#if showMemberDetails}
    <section id="community-heading" class="standing-band" aria-labelledby="home-standing-heading" data-testid="home-standing">
      <div class="standing-card">
        <h2 id="home-standing-heading">Where you stand.</h2>
        <dl>
          <div>
            <dt>Next RSVP</dt>
            <dd>
              {#if eventsUnavailable}
                <p>We couldn’t load your next RSVP.</p>
                <a href="/discord">Check Discord for game nights</a>
              {:else if heroRsvp}
                <a href={`/e/${encodeURIComponent(heroRsvp.event.eventKey)}`}>{heroRsvp.event.title}</a>
                <p>{@render teaserTime(heroRsvp.event)}</p>
                <p><span class="schedule-rsvp">{goingAnnouncementText(heroRsvp.status)}</span></p>
              {:else}
                <p>No upcoming RSVP in this preview.</p>
                <a href="/events">Browse all events</a>
              {/if}
            </dd>
          </div>
          <div>
            <dt>Leaderboard</dt>
            <dd><a href="/leaderboards/members?scope=relative">See where you place</a></dd>
          </div>
        </dl>
      </div>
    </section>
  {/if}
  {#if !session?.member}
    {@render homeLadder()}
    <section class="join-band" aria-labelledby="join-band-heading" data-testid="join-band">
      <div>
        <h2 id="join-band-heading">Pull up a <em>chair.</em></h2>
        {#if sessionUnavailable}
          <p>Sign-in isn't answering right now. The invite link still gets you into the server.</p>
        {:else if notice === "join_failed"}
          <p>The bot couldn't add you just now. The invite link still gets you in.</p>
        {:else}
          <p>{JOIN_INTRO}</p>
        {/if}
      </div>
      {#if sessionUnavailable || notice === "join_failed"}
        <a class="join-band-btn" href={sessionUnavailable ? "/discord" : inviteUrl} data-testid="join-band-invite">Join with an invite link</a>
      {:else}
        <a class="join-band-btn" href="/auth/discord" data-testid="join-band-join">Join with Discord</a>
      {/if}
    </section>
  {/if}
  <JsonLd testid="site-jsonld" json={siteGraph} />
{/snippet}
<SiteMetadata
  title="The lobby is open"
  exactTitle="Together We Own — the lobby is open"
  {canonical}
  description="We spent most of our life private. Now you can just turn up."
  theme="home"
/>
<div class="base-theme homepage-theme ember-home" data-theme="home">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="ember-home-top" data-kit-site-header>
    <div class="ember-home-row">
      <a class="brand" href="/" aria-current="page"><img src="/logo.svg" width="140" height="39" alt="Together We Own" /></a>
      <div class="ember-home-desktop">{@render primaryLinks()}</div>
      <nav class="ember-home-account" aria-label="Account">
        {#if session}
          <form method="post" action="/logout">
            <span class="sr-only">Signed in</span>
            <span class="who">{session.username}</span>
            <Button size="sm" type="submit">Sign out</Button>
          </form>
        {:else}
          <span class="sr-only">Welcome, guest</span>
          <a href="/auth/discord" aria-label="Sign in with Discord" data-testid="signin">Sign in</a>
          <Button size="sm" variant="primary" href={sessionUnavailable ? "/discord" : "/join"}>Join</Button>
        {/if}
      </nav>
      <details class="ember-home-menu">
        <summary>Menu</summary>
        {@render primaryLinks()}
      </details>
    </div>
  </header>
  <main class="ember-home-main" id="main" tabindex="-1">
    {#if data.restoredWrite}<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>{/if}
    {@render homeContent()}
  </main>
  <EmberFooter />
</div>
