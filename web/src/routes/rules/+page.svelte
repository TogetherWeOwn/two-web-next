<script lang="ts">
import ContentLeaf from "#lib/ContentLeaf.svelte";
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../src/seo";
import { RULES_INTRO } from "../../../../src/rules-content";
import type { PageProps } from "./$types";

// Markup contract of Rules (src/screens/rules.tsx): the same test ids, copy,
// join targets and stamp treatment, so the existing E2E applies unchanged.
// The header join action matches the Hono leaf's joinAction chrome byte for
// byte (Welcome-guest caption plus Join with Discord for every visitor, no
// session read); it is supplied through the static shell's accountChrome
// slot, never by reading session state.
//
// Markup is compact on purpose: Svelte preserves source whitespace inside
// text while Hono JSX collapses it, so only compact markup renders the same
// bytes (same precedent as the archive page).
let { data }: PageProps = $props();
</script>

<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href="/rules.md" />
</svelte:head>

{#snippet accountJoin()}<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>{/snippet}
<Shell
  title="House rules"
  canonical={canonicalUrl(data.appUrl, "/rules")}
  theme="content"
  leafCss={data.leafCss}
  accountChrome={accountJoin}
>
  <ContentLeaf navCurrent="rules" headingId="rules-heading" heading="House rules">
    <p class="lead">{RULES_INTRO}</p>
    {#if data.lastUpdated}<p data-testid="rules-last-updated" class="strap">Last updated <time datetime={data.lastUpdated.iso}>{data.lastUpdated.label}</time></p>{/if}
    <nav aria-label="Jump to a rule" data-testid="rules-jump"><p class="strap">Jump to a rule</p><ul>{#each data.rules as [name, , id] (id)}<li><a href={`#${id}`}>{name}</a></li>{/each}</ul></nav>
    <ol data-testid="rules-list" class="facts">{#each data.rules as [name, body, id] (id)}<li class="card"><h2 id={id}>{name}</h2><p>{body}</p><a class="rule-permalink" href={`#${id}`} aria-label={`Permalink to rule: ${name}`}>Permalink</a></li>{/each}</ol>
    <p><a class="btn" href="/join" data-testid="rules-join">Join with Discord</a>{" "}<a href="/">Back to the homepage</a></p>
  </ContentLeaf>
</Shell>
