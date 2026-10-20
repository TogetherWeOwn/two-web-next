<script lang="ts">
import type { Snippet } from "svelte";
import { loginUrl } from "../../../src/islands/contracts";

let {
  activeNav,
  loginReturnTo = null,
  accountChrome,
  hideAccount = false,
}: {
  /** "leaderboard" also renders the member board link (see the nav below). */
  activeNav?: "home" | "events" | "leaderboard";
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
    <a href="/events" aria-current={activeNav === "events" ? "page" : undefined}>Events</a>
    <!-- Hono offers this link to members only (session.member). This shell
      never reads session state, and the member board is the one Kit page
      that knows its viewer is a member, so the link renders exactly there. -->
    {#if activeNav === "leaderboard"}<a href="/leaderboards/members" aria-current="page">Leaderboard</a>{/if}
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
          <a class="btn" href={loginUrl(loginReturnTo)} data-testid="signin">Sign in with Discord</a>
        </div>
      {/if}
    </nav>
  {/if}
</header>
