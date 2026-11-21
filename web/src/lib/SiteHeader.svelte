<script lang="ts">
import type { Snippet } from "svelte";

// Default sign-in is the ordinary login round trip (/auth/discord), mirroring
// the Hono shell (src/page-shell.tsx signInUrl). The RSVP and join entries
// use loginUrl, which starts the join journey instead — never this default.
const signInUrl = (returnTo: string | null) =>
  returnTo ? `/auth/discord?next=${encodeURIComponent(returnTo)}` : "/auth/discord";

let {
  activeNav,
  member = false,
  loginReturnTo = null,
  accountChrome,
  authenticated = false,
  hideAccount = false,
  menuFallbackOnly = false,
  ember = false,
  hideJoin = false,
}: {
  /** "leaderboard" also renders the member board link (see the nav below).
    "event" marks Events as the current location on event descendants. */
  activeNav?: "home" | "events" | "event" | "leaderboard";
  /** Already-available membership from the page load (never a new read);
    members are offered the board link away from the board. */
  member?: boolean;
  loginReturnTo?: string | null;
  accountChrome?: Snippet;
  /** Drop the account area entirely, as Hono account={false} does on sessionless pages. */
  hideAccount?: boolean;
  /** Server-established session presentation, separate from membership and chrome. */
  authenticated?: boolean;
  menuFallbackOnly?: boolean;
  /** Use B1 chrome on Ember shells while legacy Kit leaves keep their existing header. */
  ember?: boolean;
  /** Recovery supplies its own Join link as the account action. */
  hideJoin?: boolean;
} = $props();
const menuIsland = '<script src="/islands/site-header-menu.js" defer></' + "script>";
const offerJoin = $derived(ember && !hideJoin && !hideAccount && !authenticated);
</script>

{#snippet joinLink(extraClass = "")}
  <a class={["ember-header-action", "ember-header-join", extraClass]} href="/join">Join</a>
{/snippet}

{#snippet menuContent()}
  <nav class="main-nav" aria-label="Primary">
    <a class:ember-menu-home={ember} href="/" aria-current={activeNav === "home" ? "page" : undefined}>Home</a>
    <a
      href="/events"
      aria-current={activeNav === "events" ? "page" : activeNav === "event" ? "location" : undefined}
      >Events</a
    >
    <!-- Hono offers this link to members only (session.member). This shell
      never reads session state itself: member-aware pages pass the boolean
      their load already holds, and the member board renders via activeNav
      (its route is members-only, so the viewer is a member by construction). -->
    {#if member || activeNav === "leaderboard"}<a
        href="/leaderboards/members"
        aria-current={activeNav === "leaderboard" ? "page" : undefined}>{ember ? "Ladder" : "Leaderboard"}</a
      >{/if}
    {#if ember}<a href="/about">About</a>{/if}
  </nav>
  {#if !ember}
    <a class="brand" href="/" aria-label="Together We Own homepage">
      <img src="/logo.svg" width="180" height="50" alt="Together We Own" />
    </a>
  {/if}
  {#if !hideAccount}
    <nav class="header-account" class:menu-signed-in={authenticated} aria-label="Account">
      {#if accountChrome}
        {@render accountChrome()}
      {:else if ember}
        {#if !authenticated}
          <a class="ember-header-action" href={signInUrl(loginReturnTo)} aria-label="Sign in with Discord" data-testid="signin">Sign in</a>
        {/if}
      {:else}
        <div class:menu-desktop-account={authenticated}>
          <span class="account-caption">Welcome, guest</span>
          <a class="btn" href={signInUrl(loginReturnTo)} data-testid="signin">Sign in with Discord</a>
        </div>
      {/if}
      {#if offerJoin}{@render joinLink()}{/if}
      {#if authenticated}
        <form class="menu-account-actions" method="post" action="/logout">
          {#if member || activeNav === "leaderboard"}<a href="/profile">Profile</a>{/if}
          <button type="submit" data-testid="menu-signout">Sign out</button>
        </form>
      {/if}
    </nav>
  {/if}
{/snippet}
<a class="skip-link" href="#main">Skip to content</a>
<header class="bar site-header" class:ember-header={ember} id="menu-sheet" data-kit-site-header>
  <a class="brand menu-brand" href="/" aria-label="Together We Own homepage" aria-current={ember && activeNav === "home" ? "page" : undefined}>
    <img src="/logo.svg" width="180" height="50" alt={ember ? "" : "Together We Own"} />
  </a>
  {#if offerJoin}{@render joinLink("ember-compact-join")}{/if}
  <a class="menu-toggle" id="kit-menu" href="#menu-sheet" aria-label="Menu" aria-controls="kit-menu-panel">
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
  </a>
  <div class="menu-sheet" id="kit-menu-panel">
    {@render menuContent()}
    <a class="menu-close" href="#kit-menu">Close menu</a>
  </div>
</header>
{#if !menuFallbackOnly}{@html menuIsland}{/if}
