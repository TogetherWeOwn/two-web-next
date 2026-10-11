<script lang="ts">
const SITE_NAME = "Together We Own";

let {
  title,
  canonical,
  robots,
  description,
  shareTitle,
  theme,
}: {
  title: string;
  canonical?: string;
  robots?: string;
  description?: string | null;
  shareTitle?: string;
  theme: "home" | "event" | "content" | "join" | "profile" | "schedule";
} = $props();

const fullTitle = $derived(`${title} — ${SITE_NAME}`);
const share = $derived(shareTitle ?? fullTitle);
const shareDescription = $derived(
  description || "Together We Own: a close-knit adult gaming community, founded 1998.",
);
const themeStylesheet = $derived(
  theme === "schedule"
    ? "/schedule-theme.css"
    : theme === "event"
      ? "/event-theme.css"
      : theme === "profile"
        ? "/profile-theme.css"
        : null,
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
  <link rel="stylesheet" href="/theme-tokens.css" />
  <link rel="stylesheet" href="/theme.css" />
  {#if themeStylesheet}<link rel="stylesheet" href={themeStylesheet} />{/if}
</svelte:head>
