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
  leafCss,
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
  /** Inlined leaf CSS for theme "content" (LEAF_CRITICAL_CSS from
    src/leaf-critical-css.ts), supplied by each leaf's server load through
    Shell. Load data is the channel on purpose: the bytes reach both the
    SSR document and a client-side navigation, but never the client bundle,
    where the 18 kB literal would count against the Kit perf budget on
    every hydrated page (ci/check-kit-perf.mjs). */
  leafCss?: string;
} = $props();

const fullTitle = $derived(exactTitle ?? `${title} — ${SITE_NAME}`);
const share = $derived(shareTitle ?? fullTitle);
const shareDescription = $derived(
  description || "Together We Own: a close-knit adult gaming community, founded 1998.",
);
// Absolute share-image URL from the page canonical's origin (og:image and
// twitter:image must be absolute; the render is a new file so no cache entry
// needs invalidating). Only canonical pages carry share images.
const shareImage = $derived.by(() => {
  if (!canonical) return null;
  try {
    return new URL("/og-1200x630.png", canonical).href;
  } catch {
    return "/og-1200x630.png";
  }
});
const themeStylesheet = $derived(
  theme === "schedule"
    ? "/schedule-theme.css"
    : theme === "event"
      ? "/event-theme.css"
      : theme === "profile"
        ? "/profile-theme.css"
        : null,
);
// Content leaves inline the exact bytes the Hono shell inlines
// (src/page-shell.tsx): styles.css + theme-tokens.css + theme.css in one
// <style> block, allowlisted by hash in the leaf CSP (src/headers.ts). The
// external links cost ~150 ms of render-blocking time on mobile, which the
// 2000 ms LCP budget on these pages cannot spare.
const leafStyleBlock = $derived(leafCss ? `<style>${leafCss}</style>` : "");
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
    <meta property="og:image" content={shareImage} />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={share} />
    {#if description}<meta name="twitter:description" content={description} />{/if}
    <meta name="twitter:image" content={shareImage} />
  {/if}
  <link rel="alternate" type="application/rss+xml" title="{SITE_NAME} Events" href="/events.rss" />
  {#if theme === "content"}
    {@html leafStyleBlock}
  {:else}
    <link rel="stylesheet" href="/styles.css" />
    <link rel="preload" href="/fonts/chakra-petch-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
    <!-- Kit token source is web/src/app.css (Tailwind v4 @theme, Lobby Ember),
      not public/theme-tokens.css, which stays Hono-only outside the inlined
      leaf block above. -->
    <link rel="stylesheet" href="/theme.css" />
  {/if}
  {#if themeStylesheet}<link rel="stylesheet" href={themeStylesheet} />{/if}
</svelte:head>
