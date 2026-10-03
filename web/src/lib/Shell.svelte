<script lang="ts">
import type { Snippet } from "svelte";
import { loginUrl } from "../../../src/islands/contracts";

// Svelte twin of the Hono Layout + schedule Shell (src/pages.tsx,
// src/events/pages.tsx) for the archive page: same head tags in the same
// order, same skip link, same schedule header/main/footer chrome.
let {
  title,
  canonical,
  robots,
  description,
  shareTitle,
  loginReturnTo = null,
  headerCenter,
  children,
}: {
  title: string;
  canonical?: string;
  robots?: string;
  description?: string | null;
  shareTitle?: string;
  loginReturnTo?: string | null;
  headerCenter?: Snippet;
  children: Snippet;
} = $props();

const SITE_NAME = "Together We Own";
const fullTitle = $derived(`${title} — ${SITE_NAME}`);
const share = $derived(shareTitle ?? `${title} — ${SITE_NAME}`);
const shareDescription = $derived(
  description || "Together We Own: a close-knit adult gaming community, founded 1998.",
);
</script>

<svelte:head>
  {#if robots}<meta name="robots" content={robots} />{/if}
  <title>{fullTitle}</title>
  <meta name="description" content={shareDescription} />
  {#if canonical}
    <link rel="canonical" href={canonical} />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content={SITE_NAME} />
    <meta property="og:url" content={canonical} />
    <meta property="og:title" content={share} />
    {#if description}<meta property="og:description" content={description} />{/if}
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content={share} />
    {#if description}<meta name="twitter:description" content={description} />{/if}
  {/if}
  <link rel="alternate" type="application/rss+xml" title="{SITE_NAME} Events" href="/events.rss" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="preload" href="/fonts/display-latin-700.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
  <link rel="stylesheet" href="/theme.css" />
  <link rel="stylesheet" href="/schedule-theme.css" />
</svelte:head>

<a class="skip-link" href="#main">Skip to content</a>
<header class="bar site-header">
  <nav class="main-nav" aria-label="Primary">
    <a href="/">Home</a>
    <a href="/events" aria-current="page">Events</a>
  </nav>
  <a class="brand" href="/" aria-label="Together We Own homepage">
    <img src="/logo.svg" width="64" height="64" alt="Together We Own" />
  </a>
  <nav class="header-account" aria-label="Account">
    {#if headerCenter}
      {@render headerCenter()}
    {:else}
      <div>
        <span class="account-caption">Welcome, guest</span>
        <a class="btn" href={loginUrl(loginReturnTo)} data-testid="signin">Sign in with Discord</a>
      </div>
    {/if}
  </nav>
</header>
<main class="events-page" id="main" tabindex="-1">{@render children()}</main>
<footer>
  Together We Own · adult gaming community · founded 1998
  <nav aria-label="Site">
    <a href="/about">About</a> <a href="/faq">FAQ</a> <a href="/rules">House rules</a>
    <a href="/privacy">Privacy</a>
  </nav>
</footer>
