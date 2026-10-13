<script lang="ts">
const SITE_NAME = "Together We Own";

let {
  title,
  canonical,
  robots,
  description,
  shareTitle,
  exactTitle,
  theme,
}: {
  title: string;
  canonical?: string;
  robots?: string;
  description?: string | null;
  shareTitle?: string;
  /** Rendered verbatim with no site-name suffix: pages whose Hono title
    already carries the site name (the homepage). Absent by default, so every
    existing page keeps its derived title byte-for-byte. */
  exactTitle?: string;
  theme: "home" | "event" | "content" | "join" | "profile" | "schedule";
} = $props();

const fullTitle = $derived(exactTitle ?? `${title} — ${SITE_NAME}`);
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
  <!-- Kit token source is web/src/app.css (Tailwind v4 @theme, Open Lobby),
    not public/theme-tokens.css, which stays Hono-only. -->
  <link rel="stylesheet" href="/theme.css" />
  {#if themeStylesheet}<link rel="stylesheet" href={themeStylesheet} />{/if}
</svelte:head>
