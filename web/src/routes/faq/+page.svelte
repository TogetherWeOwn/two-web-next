<script lang="ts">
import ContentLeaf from "#lib/ContentLeaf.svelte";
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of FAQ (src/screens/faq.tsx): the same strap, lead,
// question cards, test ids, copy, join targets and nav treatment, so the
// existing E2E applies unchanged. The copy is the shared src/faq-content.ts
// source passed in as data — never a pasted sentence — so the two renderers
// cannot drift. The header join action matches the Hono leaf's joinAction
// chrome byte for byte (Welcome-guest caption plus Join with Discord for
// every visitor, no session read); it is supplied through the static shell's
// accountChrome slot, never by reading session state.
//
// Markup is compact on purpose: Svelte preserves source whitespace inside
// text while Hono JSX collapses it, so only compact markup renders the same
// bytes (same precedent as the archive page).
let { data }: PageProps = $props();
const { appUrl, faqs, lastReviewed, leafCss } = $derived(data);
</script>

<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href="/faq.md" />
</svelte:head>

{#snippet accountJoin()}<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>{/snippet}
<Shell
  title="FAQ"
  canonical={canonicalUrl(appUrl, "/faq")}
  theme="content"
  {leafCss}
  accountChrome={accountJoin}
>
  <ContentLeaf navCurrent="faq" headingId="faq-heading" heading="Frequently asked questions">
    <p class="strap">New here? Start here</p>
    <p class="lead">Short answers to what newcomers actually ask. If yours isn't here, ask in general or DM a moderator.</p>
    {#if lastReviewed}<p data-testid="faq-last-reviewed" class="strap">Last reviewed <time datetime={lastReviewed.iso}>{lastReviewed.label}</time></p>{/if}
    <nav aria-label="FAQ topics"><p>Jump to a topic</p><div class="facts rank-stack">{#each faqs as group (group.sectionId)}<a href={`#${group.sectionId}`}>{group.section}</a>{/each}</div></nav>
    <div data-testid="faq-list">{#each faqs as group (group.sectionId)}<section aria-labelledby={group.sectionId}><h2 id={group.sectionId} class="faq-target" tabindex="-1">{group.section}</h2><div>{#each group.items as [question, answer, link, id] (id)}<div class="card"><h3 id={id} class="faq-target" tabindex="-1">{question}</h3><p>{answer}{#if link}{" "}<a href={link.href}>{link.label}</a>{/if}</p><a href={`#${id}`} class="faq-permalink" aria-label={`Link to this answer — ${question}`}>Link to this answer</a></div>{/each}</div></section>{/each}</div>
    <p><a class="btn" href="/join" data-testid="faq-join">Join with Discord</a>{" "}<a href="/">Back to the homepage</a></p>
  </ContentLeaf>
</Shell>
