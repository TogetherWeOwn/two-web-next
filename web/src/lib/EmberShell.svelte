<script lang="ts">
import type { Snippet } from "svelte";
import EmberFooter from "#lib/EmberFooter.svelte";
import SiteHeader from "#lib/SiteHeader.svelte";

let {
  activeNav,
  member = false,
  loginReturnTo = null,
  accountChrome,
  authenticated = false,
  hideAccount = false,
  children,
}: {
  activeNav?: "home" | "events" | "event" | "leaderboard";
  member?: boolean;
  loginReturnTo?: string | null;
  accountChrome?: Snippet;
  authenticated?: boolean;
  hideAccount?: boolean;
  children: Snippet;
} = $props();
</script>

<!-- SiteHeader owns the skip link; the consuming Kit layout loads app.css and site-header.css. -->
<div class="base-theme">
  <SiteHeader {activeNav} {member} {loginReturnTo} {accountChrome} {authenticated} {hideAccount} />
  <main id="main" tabindex="-1">{@render children()}</main>
  <EmberFooter />
</div>

<style>
  .base-theme main {
    max-width: calc(var(--two-layout-container) + 2 * var(--two-layout-gutter-wide));
    padding-inline: var(--two-layout-gutter-wide);
  }

  @media (max-width: 820px) {
    .base-theme main { padding-inline: var(--two-layout-gutter-compact); }
  }
</style>
