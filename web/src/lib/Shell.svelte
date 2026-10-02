<script lang="ts">
  import type { Snippet } from "svelte";

  // Svelte twin of the Hono Layout + events Shell (src/pages.tsx,
  // src/events/pages.tsx) for a page without a theme: same head tags in the
  // same order, same skip link, header and <main> landmark.
  let {
    title,
    canonical,
    robots,
    description,
    shareTitle,
    children,
  }: {
    title: string;
    canonical?: string;
    robots?: string;
    description?: string | null;
    shareTitle?: string;
    children: Snippet;
  } = $props();

  const SITE_NAME = "Together We Own";
  const fullTitle = $derived(`${title} — ${SITE_NAME}`);
  const share = $derived(shareTitle ?? title);
</script>

<svelte:head>
  {#if robots}<meta name="robots" content={robots} />{/if}
  <title>{fullTitle}</title>
  <meta name="description" content={description || "Together We Own: a close-knit adult gaming community, founded 1998."} />
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
</svelte:head>

<a class="skip-link" href="#main">Skip to content</a>
<header class="bar">
  <a class="brand" href="/">TWO</a>
  <nav aria-label="Primary">
    <a href="/events">Events</a>
  </nav>
</header>
<main id="main" tabindex="-1">{@render children()}</main>
