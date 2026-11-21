<script lang="ts">
import type { Snippet } from "svelte";
import EmberFooter from "#lib/EmberFooter.svelte";
import SiteHeader from "#lib/SiteHeader.svelte";
import "./ember-header.css";

let {
  activeNav,
  member = false,
  loginReturnTo = null,
  accountChrome,
  authenticated = false,
  hideAccount = false,
  hideJoin = false,
  menuFallbackOnly = false,
  children,
}: {
  activeNav?: "home" | "events" | "event" | "leaderboard";
  member?: boolean;
  loginReturnTo?: string | null;
  accountChrome?: Snippet;
  authenticated?: boolean;
  hideAccount?: boolean;
  hideJoin?: boolean;
  /** Keep pages with an exact script contract on the fragment menu. */
  menuFallbackOnly?: boolean;
  children: Snippet;
} = $props();
</script>

<!-- SiteHeader owns the skip link; the consuming Kit layout loads app.css and site-header.css. -->
<div class="base-theme">
  <SiteHeader ember {activeNav} {member} {loginReturnTo} {accountChrome} {authenticated} {hideAccount} {hideJoin} {menuFallbackOnly} />
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
