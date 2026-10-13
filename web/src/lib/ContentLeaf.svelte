<script lang="ts">
import type { Snippet } from "svelte";

// Shared static-leaf chrome for the content leaves (about/faq/rules/privacy):
// the community-information nav plus the content section wrapper. Mirrors
// src/page-shell.tsx Leaf's body markup (same classes, same links, same
// aria-current contract) so every static-page lane card renders one parity
// surface instead of inventing its own. Title, canonical and header/footer
// chrome stay in Shell.svelte; no per-leaf CSS lives here.
//
// Markup is compact on purpose: Svelte preserves source whitespace inside
// text while Hono JSX collapses it, so only compact markup renders the same
// bytes (same precedent as the archive page).
let {
  navCurrent,
  headingId,
  heading,
  children,
}: {
  navCurrent: "about" | "faq" | "rules" | "privacy";
  headingId: `${string}-heading`;
  heading: string;
  children: Snippet;
} = $props();

const links = [
  { key: "about", href: "/about", label: "About" },
  { key: "faq", href: "/faq", label: "FAQ" },
  { key: "rules", href: "/rules", label: "House rules" },
  { key: "privacy", href: "/privacy", label: "Privacy" },
] as const;
</script>

<div class="content-layout">
  <nav class="content-nav" aria-label="Community information">{#each links as link (link.key)}<a href={link.href} aria-current={navCurrent === link.key ? "page" : undefined}>{link.label}</a>{/each}</nav>
  <section class="content-page" aria-labelledby={headingId}><h1 id={headingId}>{heading}</h1>{@render children()}</section>
</div>
