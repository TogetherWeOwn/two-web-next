<script lang="ts">
import ContentLeaf from "#lib/ContentLeaf.svelte";
import Shell from "#lib/Shell.svelte";
import { LEAF_DESCRIPTIONS } from "../../../../src/leaf-descriptions";
import { canonicalUrl } from "../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of About (src/screens/about.tsx): the same strap, lead,
// fact cards, test ids, copy, join targets and nav treatment, so the existing
// E2E applies unchanged. The copy is the shared src/about-content.ts source
// passed in as data — never a pasted sentence — so the two renderers cannot
// drift. The header join action matches the Hono leaf's joinAction chrome
// byte for byte (Welcome-guest caption plus Join with Discord for every
// visitor, no session read); it is supplied through the static shell's
// accountChrome slot, never by reading session state.
//
// Markup is compact on purpose: Svelte preserves source whitespace inside
// text while Hono JSX collapses it, so only compact markup renders the same
// bytes (same precedent as the archive page).
let { data }: PageProps = $props();
const { appUrl, strap, lead, facts, leafCss } = $derived(data);
</script>

<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href="/about.md" />
</svelte:head>

{#snippet accountJoin()}<div><span class="account-caption">Welcome, guest</span><a class="btn" href="/join">Join with Discord</a></div>{/snippet}
<Shell
  title="About"
  canonical={canonicalUrl(appUrl, "/about")}
  theme="content"
  description={LEAF_DESCRIPTIONS["/about"]}
  {leafCss}
  accountChrome={accountJoin}
>
  <ContentLeaf navCurrent="about" headingId="about-heading" heading="About Together We Own">
    <p class="strap">{strap}</p>
    <p class="lead">{lead}</p>
    <dl data-testid="about-facts" class="facts">{#each facts as [term, definition] (term)}<div class="card"><dt>{term}</dt><dd>{definition}</dd></div>{/each}</dl>
    <p><a class="btn" href="/join" data-testid="about-join">Join with Discord</a>{" "}<a href="/">Back to the homepage</a></p>
  </ContentLeaf>
</Shell>
