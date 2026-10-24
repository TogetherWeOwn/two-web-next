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
  hideAccount = false,
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
} = $props();
</script>

<a class="skip-link" href="#main">Skip to content</a>
<header class="bar site-header">
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
  <a class="brand" href="/" aria-label="Together We Own homepage">
    <img src="/logo.svg" width="64" height="64" alt="Together We Own" />
  </a>
  {#if !hideAccount}
    <nav class="header-account" aria-label="Account">
      {#if accountChrome}
        {@render accountChrome()}
      {:else}
        <div>
          <span class="account-caption">Welcome, guest</span>
          <a class="btn" href={signInUrl(loginReturnTo)} data-testid="signin">Sign in with Discord</a>
        </div>
      {/if}
    </nav>
  {/if}
</header>
