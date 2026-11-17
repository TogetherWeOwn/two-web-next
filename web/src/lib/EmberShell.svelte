<script lang="ts">
import type { Snippet } from "svelte";
import EmberFooter from "#lib/EmberFooter.svelte";
import SiteHeader from "#lib/SiteHeader.svelte";

let {
  activeNav,
  member = false,
  loginReturnTo = null,
  accountChrome,
  hideAccount = false,
  children,
}: {
  activeNav?: "home" | "events" | "event" | "leaderboard";
  member?: boolean;
  loginReturnTo?: string | null;
  accountChrome?: Snippet;
  hideAccount?: boolean;
  children: Snippet;
} = $props();
</script>

<!-- SiteHeader owns the skip link; the consuming Kit layout loads app.css and site-header.css. -->
<div class="base-theme">
  <SiteHeader {activeNav} {member} {loginReturnTo} {accountChrome} {hideAccount} />
  <main id="main" tabindex="-1">{@render children()}</main>
  <EmberFooter />
</div>
