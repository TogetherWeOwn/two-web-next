<script lang="ts">
import type { Snippet } from "svelte";
import { loginUrl } from "../../../src/islands/contracts";

let {
  activeNav,
  loginReturnTo = null,
  accountChrome,
}: {
  activeNav?: "home" | "events";
  loginReturnTo?: string | null;
  accountChrome?: Snippet;
} = $props();
</script>

<a class="skip-link" href="#main">Skip to content</a>
<header class="bar site-header">
  <nav class="main-nav" aria-label="Primary">
    <a href="/" aria-current={activeNav === "home" ? "page" : undefined}>Home</a>
    <a href="/events" aria-current={activeNav === "events" ? "page" : undefined}>Events</a>
  </nav>
  <a class="brand" href="/" aria-label="Together We Own homepage">
    <img src="/logo.svg" width="64" height="64" alt="Together We Own" />
  </a>
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
</header>
