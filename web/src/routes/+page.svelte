<script lang="ts">
import "./home-presentation.css";
import JsonLd from "#lib/JsonLd.svelte";
import Shell from "#lib/Shell.svelte";
import type { HomeUpcomingRow } from "../../../src/events/reads";
import { groupTeaserEvents } from "../../../src/events/teaser-groups";
import { featuredImageSrc } from "../../../src/featured-image";
import type { HomeNotice } from "../../../src/home-copy";
import {
  SPOTS_LEFT_TESTID,
  cardTimeLabel,
  goingCountText,
  isValidZone,
} from "../../../src/islands/contracts";
import { canonicalUrl } from "../../../src/seo";
import { siteJsonLd } from "../../../src/seo-json-ld";
import type { PageProps } from "./$types";

// Markup contract of Home (src/screens/home.tsx): session-aware header,
// notice slot, hero, counts, featured, community panels, ladder, events and
// site JSON-LD are shared, so the existing homepage tests still apply. Panel
// data comes from the shared readers via +page.server.ts — never recomputed
// here — and copy comes from src/home-copy, never a pasted sentence.
let { data }: PageProps = $props();
const {
  session,
  sessionUnavailable,
  notice,
  joinResult,
  inviteUrl,
  appUrl,
  counts,
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
const groupedEvents = $derived(groupTeaserEvents<HomeUpcomingRow>(upcomingEvents, new Date()));
</script>

{#snippet guestChrome()}
  <div>
    <span class="account-caption">Welcome, guest</span>
    <a class="btn" href="/auth/discord" data-testid="signin">Sign in with Discord</a>
  </div>
{/snippet}

{#snippet memberChrome()}
  <form method="post" action="/logout">
    <span class="account-caption">Signed in</span>
    <span class="who">{session?.username}</span>
    <button type="submit" class="link">Sign out</button>
  </form>
{/snippet}

<Shell
  restoredWrite={data.restoredWrite}
  title="The lobby is open"
  exactTitle="Together We Own — the lobby is open"
  {canonical}
  description="We spent most of our life private. Now you can just turn up."
  theme="home"
  activeNav="home"
  member={session?.member ?? false}
  accountChrome={session ? memberChrome : guestChrome}
>
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
    <p class="strap">A close-knit gaming clan / mostly evenings / 18+</p>
    <h1 id="home-heading">The lobby is open.</h1>
    <div class="hero-action">
      {#if sessionUnavailable}
        <a class="btn" href="/discord" data-testid="discord-join">Join with an invite link</a>
      {:else if session?.member}
        <a class="btn" href={inviteUrl}>Open Discord</a>
      {:else}
        <a class="btn" href="/auth/discord" data-testid="join">Join with Discord</a>
      {/if}
      <p class="lead">We spent most of our life private. Now you can just turn up.</p>
    </div>
    {#if !session && !sessionUnavailable && eventsUnavailable}
      <p>
        <a href="/discord" data-testid="discord-join">Join with an invite link instead</a>
      </p>
    {/if}
    {#if notice === "join_failed"}
      <p>
        <a href={inviteUrl}>Join with an invite link instead</a>
      </p>
    {/if}
    {#if counts.memberCount != null}
      <p class="counts" data-testid="member-count">
        <strong>{counts.memberCount}</strong> members{#if counts.onlineCount != null && counts.onlineCount > 0}
          {" · "}<strong>{counts.onlineCount}</strong> online{/if}
      </p>
    {/if}
  </section>
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
  <section class="highlights" aria-labelledby="community-heading">
    <div class="band-head">
      <h2 id="community-heading">No application. <span>No interview.</span></h2>
      <p>Not a crowd. A place that knows your name.</p>
    </div>
    <ul class="hl" role="list" data-testid="home-highlights">
      <li>
        <p class="hl-cadence">Est. 1998 · 18+</p>
        <h3>Grown-ups, mostly evenings</h3>
        <p>We've played together since 1998: forum years, then voice years. It's an adult clan, and we're mostly on in the evenings.</p>
      </li>
      <li>
        <p class="hl-cadence">Voice-first</p>
        <h3>Turn up, say hello</h3>
        <p>The community lives in voice. Small enough that people notice when you come back.</p>
      </li>
      <li>
        <p class="hl-cadence">Everyone starts as a Prospect</p>
        <h3>Trust and time, not grind</h3>
        <p>Show up a few times, play, and you become a Member. No tryout and no skill bar.</p>
      </li>
      <li>
        <p class="hl-cadence">5 XP per voice minute</p>
        <h3>Ranks from playing</h3>
        <p>Messages and voice time earn XP. At set levels the bot gives you a role reward, and it never takes one away.</p>
      </li>
    </ul>
    <section class="discord-preview" aria-labelledby="discord-heading">
      <h3 id="discord-heading">In the Discord</h3>
      <p>Visit the join page for the server preview and ways to join.</p>
      <p>
        <a href="/join#join-heading" data-testid="home-widget-link">View the Discord lobby</a>
        {" · "}
        <a href="/discord" data-testid="home-discord-invite">Open Discord</a>
      </p>
    </section>
  </section>
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
  <section class="event-band" aria-labelledby="home-events-heading">
    <p class="strap">Next up</p>
    <h2 id="home-events-heading">What’s on. <span>Come along.</span></h2>
    {#if upcomingEvents.length > 0}
      <ul class="facts home-events" data-testid="home-events-list">
        <!-- csr=false: omit this server-rendered list from the unused client asset.
             Direct server compilation without Vite's env also renders it. -->
        {#if import.meta.env?.SSR !== false}{#each groupedEvents as group (group.key)}
          <li class="home-events-group" data-testid={"home-events-group-" + group.key}>
            <h3 class="strap">{group.label}</h3>
          </li>
          {#each group.events as event (event.source === "discord" ? `discord-${event.discordId}` : `canonical-${event.eventKey}`)}
            <li class="card" data-source={event.source}>
              <a
                class="home-event-link"
                href={event.source === "discord" ? inviteUrl : `/e/${encodeURIComponent(event.eventKey)}`}
                data-testid={event.source === "discord" ? "home-event-discord" : undefined}
              >
                <p>
                  <time datetime={event.startsAt.toISOString()}>
                    {cardTimeLabel(event.startsAt, event.timezone)} ({isValidZone(event.timezone)
                      ? event.timezone
                      : "UTC"})
                  </time>
                </p>
                <div class="event-meta">
                <h3>{event.title}</h3>
                {#if event.location}<p>{event.location}</p>{/if}
                {#if event.source === "discord"}
                  <p>RSVP in Discord</p>
                {:else}
                  <p>
                    {goingCountText(event.goingCount, event.capacity)}
                    {#if event.capacity !== null && (event.goingOccupancy ?? event.goingCount) >= event.capacity}
                      {" · "}
                      <span data-testid={SPOTS_LEFT_TESTID}>Full</span>
                    {/if}
                  </p>
                {/if}
                </div>
              </a>
            </li>
          {/each}
        {/each}{/if}
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
  {#if !session?.member}
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
      {#if sessionUnavailable}
        <a class="join-band-btn" href="/discord" data-testid="join-band-invite">Join with an invite link</a>
      {:else if notice === "join_failed"}
        <a class="join-band-btn" href={inviteUrl} data-testid="join-band-invite">Join with an invite link</a>
      {:else}
        <a class="join-band-btn" href="/auth/discord" data-testid="join-band-join">Join with Discord</a>
      {/if}
    </section>
  {/if}
  <JsonLd testid="site-jsonld" json={siteGraph} />
</Shell>
