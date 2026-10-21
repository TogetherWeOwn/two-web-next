<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of Join (src/screens/join.tsx): test ids, links, copy and
// the click-to-load widget facade are shared, so the existing E2E and island
// apply. Copy is duplicated here deliberately (never imported from the .tsx):
// importing the Hono screen would bundle the JSX runtime into the Kit worker.
// A component-level <script> is Svelte's own; the island tag is emitted as markup.
let { data }: PageProps = $props();
// The server load builds /join/discord from the sanitized query inputs.
const { inviteUrl, widgetUrl, widgetSnapshot, oneClickHref, appUrl, joinResult } = $derived(data);
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
  description="Approve once with Discord and we will add you to the server."
  theme="join"
  {accountChrome}
>
  {#if joinResult}
    <p class="notice" role="status" data-testid="join-result">
      {#if joinResult === "added"}
        You are in. Finish Discord's rules screening before you can post.
      {:else}
        You are already in the server.{" "}
        <a href="/discord" data-testid="reinvite-link">Rejoin with the Discord invite</a>
      {/if}
    </p>
  {/if}
  <section class="join-layout" aria-labelledby="join-heading">
    <div class="join-panel">
      <h1 id="join-heading">Join Together We Own</h1>
      <p class="lead">Approve once with Discord and we will add you to the server.</p>
      <p>One click with Discord and we'll add you to the server — no invite link, no waiting.</p>
      <p class="join-actions">
        <a class="btn" href={oneClickHref} data-testid="join-oneclick">Join with Discord</a>{" "}
        <a href={inviteUrl} data-testid="join-invite">Join with an invite link instead</a>
      </p>
    </div>
    <div class="join-preview">
      {#if widgetSnapshot}
        <section aria-labelledby="discord-presence-heading" data-testid="join-widget-presence">
          <h2 id="discord-presence-heading">
            {#if widgetSnapshot.stale}In {widgetSnapshot.name} as of the last update{:else}In {widgetSnapshot.name} now{/if}
          </h2>
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
            <p>
              {#if widgetSnapshot.stale}No voice channels open as of the last update.{:else}No voice channels open right now.{/if}
            </p>
          {/if}
          <!-- Public page: aggregate presence only (count + channels). Member
            names stay off this logged-out, indexed page per privacy policy v2;
            the snapshot may still carry them server-side for a future
            member-gated use, but they never render here. -->
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
</Shell>
