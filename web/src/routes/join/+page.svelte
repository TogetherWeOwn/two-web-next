<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { cardTimeLabel, isValidZone } from "../../../../src/islands/contracts";
import { canonicalUrl } from "../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of Join (src/screens/join.tsx): test ids, links, copy and
// the click-to-load widget facade are shared, so the existing E2E and island
// apply. The banner and intro sentences arrive as load data from the shared
// plain-TS copy module (never imported from the .tsx): importing the Hono
// screen would bundle the JSX runtime into the Kit worker.
// A component-level <script> is Svelte's own; the island tag is emitted as markup.
let { data }: PageProps = $props();
// The server load builds /join/discord from the sanitized query inputs.
const {
  inviteUrl,
  widgetUrl,
  widgetSnapshot,
  oneClickHref,
  appUrl,
  joinResult,
  nextEvent,
  notice,
} = $derived(data);
const { HOME_JOIN_RESULT_COPY, JOIN_INTRO } = $derived(data.joinCopy);
// The island binder is a plain script tag, not hydration: with csr=false the
// no-JS contract (links, presence or fallback copy in the raw fetch body) holds.
const island = '<script src="/islands/join-widget.js" defer></' + "script>";
</script>

<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href="/join.md" />
</svelte:head>

{#snippet accountChrome()}
  <div>
    <span class="account-caption">Welcome, guest</span>
    <a class="btn" href="/auth/discord" data-testid="signin">Sign in with Discord</a>
  </div>
{/snippet}

<Shell
  title="Join Together We Own"
  canonical={canonicalUrl(appUrl, "/join")}
  description={JOIN_INTRO}
  theme="join"
  {accountChrome}
>
  {#if joinResult}
    <p class="notice" role="status" data-testid="join-result">
      {#if joinResult === "added"}
        {HOME_JOIN_RESULT_COPY.added}
      {:else}
        {HOME_JOIN_RESULT_COPY.alreadyInServer}{" "}
        <a href="/discord" data-testid="reinvite-link">{HOME_JOIN_RESULT_COPY.reinvite}</a>
      {/if}
    </p>
  {/if}
  {#if notice}
    <!-- Already allowlisted by the load (start-failed or null). Display-only:
      explains a failed start, never echoed into the one-click href. Copy is
      byte-identical to the Hono banner (src/screens/join.tsx). -->
    <p class="notice" role="status" data-testid="join-start-notice">
      The Discord approval failed to start — try again below.
    </p>
  {/if}
  <section class="join-layout" aria-labelledby="join-heading">
    <div class="join-panel">
      <h1 id="join-heading">Join Together We Own</h1>
      <p class="lead">{JOIN_INTRO}</p>
      <p>One click with Discord and we'll add you to the server — no invite link, no waiting.</p>
      <p class="join-actions">
        <a class="btn" href={oneClickHref} data-testid="join-oneclick">Join with Discord</a>{" "}
        <a href={inviteUrl} data-testid="join-invite">Join with an invite link instead</a>
      </p>
    </div>
    <div class="join-preview">
      {#if widgetSnapshot}
        <section aria-labelledby="discord-presence-heading" data-testid="join-widget-presence">
          <h2 id="discord-presence-heading">In {widgetSnapshot.name} now</h2>
          <p data-testid="join-widget-online">
            <strong>{widgetSnapshot.presenceCount}</strong>{" "}
            {widgetSnapshot.presenceCount === 1 ? "member online" : "members online"}
          </p>
          <p>
            <a href={widgetSnapshot.inviteUrl ?? inviteUrl} data-testid="join-widget-invite">
              Join with an invite link
            </a>
          </p>
          {#if widgetSnapshot.channels.length > 0}
            <h3>Voice and stage channels</h3>
            <ul data-testid="join-widget-channels">
              {#each widgetSnapshot.channels as channel (channel.id)}<li>{channel.name}</li>{/each}
            </ul>
          {:else}
            <p>No voice channels open right now.</p>
          {/if}
          <!-- Public page: aggregate presence only (count + channels). The load
            projects the snapshot before returning, so member names never reach
            __data.json on this logged-out, indexed page (privacy policy v2). -->
        </section>
        {#if widgetUrl}
          <div class="strap">
            <p>Discord's live server preview loads only when you ask for it.</p>
            <a
              class="btn"
              href={widgetUrl}
              referrerpolicy="no-referrer"
              data-join-widget
              data-testid="join-widget-load"
            >
              Show live server preview
            </a>
            {@html island}
          </div>
        {/if}
      {:else if widgetUrl}
        <div class="strap">
          <p>Discord's live server preview loads only when you ask for it.</p>
          <a
            class="btn"
            href={widgetUrl}
            referrerpolicy="no-referrer"
            data-join-widget
            data-testid="join-widget-load"
          >
            Show live server preview
          </a>
          {@html island}
        </div>
      {:else}
        <p class="strap" data-testid="join-widget-fallback">
          Live server preview is unavailable — the join button above still works.
        </p>
      {/if}
    </div>
  </section>
  <!-- The next game night: same block, copy and testids as the Hono screen
    (src/screens/join.tsx). The load carries the teaser's soonest merged row
    as nextEvent; null renders nothing, so an empty or unreadable schedule
    is byte-identical to the page without this block. Discord-source rows
    keep the invite link like the homepage teaser. -->
  {#if nextEvent}
    <section
      data-testid="join-next-event"
      data-source={nextEvent.source}
      aria-labelledby="join-next-event-heading"
    >
      <h2 id="join-next-event-heading">Next game night</h2>
      <a
        class="join-next-event-link"
        href={nextEvent.source === "discord"
          ? inviteUrl
          : `/e/${encodeURIComponent(nextEvent.eventKey)}`}
        data-testid={nextEvent.source === "discord"
          ? "join-next-event-discord"
          : "join-next-event-link"}
      >
        <p>
          <time data-testid="join-next-event-time" datetime={nextEvent.startsAt.toISOString()}>
            {cardTimeLabel(nextEvent.startsAt, nextEvent.timezone)} ({isValidZone(
              nextEvent.timezone,
            )
              ? nextEvent.timezone
              : "UTC"})
          </time>
        </p>
        <h3 data-testid="join-next-event-title">{nextEvent.title}</h3>
        <p data-testid="join-next-event-venue">{nextEvent.location ?? "Online"}</p>
      </a>
    </section>
  {/if}
</Shell>
