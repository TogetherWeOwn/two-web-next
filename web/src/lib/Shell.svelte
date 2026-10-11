<script lang="ts">
import type { Snippet } from "svelte";
import SiteFooter from "#lib/SiteFooter.svelte";
import SiteHeader from "#lib/SiteHeader.svelte";
import SiteMetadata from "#lib/SiteMetadata.svelte";

let {
  title,
  canonical,
  robots,
  description,
  shareTitle,
  theme,
  activeNav,
  mainClass,
  loginReturnTo = null,
  accountChrome,
  children,
}: {
  title: string;
  canonical?: string;
  robots?: string;
  description?: string | null;
  shareTitle?: string;
  theme: "home" | "event" | "content" | "join" | "profile" | "schedule";
  activeNav?: "home" | "events";
  mainClass?: string;
  loginReturnTo?: string | null;
  /** Explicitly supplied session-aware chrome; the static shell never reads session state. */
  accountChrome?: Snippet;
  children: Snippet;
} = $props();

const themeClass = $derived(theme === "home" ? "homepage-theme" : `${theme}-theme`);
</script>

<SiteMetadata {title} {canonical} {robots} {description} {shareTitle} {theme} />
<div class="base-theme {themeClass}" data-theme={theme}>
  <SiteHeader {activeNav} {loginReturnTo} {accountChrome} />
  <main class={mainClass} id="main" tabindex="-1">{@render children()}</main>
  <SiteFooter />
</div>
