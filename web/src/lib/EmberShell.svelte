<script lang="ts">
import type { Snippet } from "svelte";
import EmberFooter from "#lib/EmberFooter.svelte";
import SiteHeader from "#lib/SiteHeader.svelte";
import headerCss from "./ember-header.css?url";

let {
  activeNav,
  member = false,
  loginReturnTo = null,
  accountChrome,
  authenticated = false,
  hideAccount = false,
  menuFallbackOnly = false,
  children,
}: {
  activeNav?: "home" | "events" | "event" | "leaderboard";
  member?: boolean;
  loginReturnTo?: string | null;
  accountChrome?: Snippet;
  authenticated?: boolean;
  hideAccount?: boolean;
  /** Keep pages with an exact script contract on the fragment menu. */
  menuFallbackOnly?: boolean;
  children: Snippet;
} = $props();
</script>

<svelte:head><link rel="stylesheet" href={headerCss} /></svelte:head>
<div class="base-theme">
  <SiteHeader ember {activeNav} {member} {loginReturnTo} {accountChrome} {authenticated} {hideAccount} {menuFallbackOnly} />
  <main id="main" tabindex="-1">{@render children()}</main>
  <EmberFooter />
</div>

<style>
  .base-theme main {
    max-width: var(--two-layout-container);
    padding-inline: var(--two-layout-gutter-wide);
  }

  @media (max-width: 820px) {
    .base-theme main { padding-inline: var(--two-layout-gutter-compact); }
  }
</style>
