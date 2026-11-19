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
} = $props();
const menuIsland = '<script src="/islands/site-header-menu.js" defer></' + "script>";
</script>

{#snippet primary()}
  <nav class="main-nav" aria-label="Primary">
    <a href="/" aria-current={activeNav === "home" ? "page" : undefined}>Home</a>
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
        aria-current={activeNav === "leaderboard" ? "page" : undefined}>Leaderboard</a
      >{/if}
  </nav>
{/snippet}

{#snippet lockup(compact: boolean)}
  <a class="brand" class:menu-brand={compact} href="/" aria-label="Together We Own homepage">
    <img src="/logo.svg" width="180" height="50" alt="Together We Own" />
  </a>
{/snippet}

{#snippet account()}
  {#if !hideAccount}
    <nav class="header-account" class:menu-signed-in={authenticated} aria-label="Account">
      {#if accountChrome}
        {@render accountChrome()}
      {:else}
        <div class:menu-desktop-account={authenticated}>
          <span class="account-caption">Welcome, guest</span>
          <a class="btn" href={signInUrl(loginReturnTo)} data-testid="signin">Sign in with Discord</a>
        </div>
      {/if}
      {#if authenticated}
        <div class="menu-account-actions">
          <a href="/profile">Profile</a>
          <form method="post" action="/logout">
            <button type="submit" data-testid="menu-signout">Sign out</button>
          </form>
        </div>
      {/if}
    </nav>
  {/if}
{/snippet}

<a class="skip-link" href="#main">Skip to content</a>
<header class="bar site-header" data-kit-site-header>
  {@render lockup(true)}
  <a class="menu-toggle" id="kit-menu" href="#menu-sheet" aria-label="Menu" aria-controls="menu-sheet">
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  </a>
  <div class="menu-sheet" id="menu-sheet">
    {@render primary()}
    {@render lockup(false)}
    {@render account()}
    <a class="menu-close" href="#kit-menu">Close menu</a>
  </div>
</header>
{#if !menuFallbackOnly}{@html menuIsland}{/if}
