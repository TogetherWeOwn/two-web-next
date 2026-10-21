<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of Privacy (src/screens/privacy.tsx): version strap,
// pre-rendered policy HTML, join/back links and the content-leaf nav are
// shared, so the existing privacy tests and footer links still apply. The
// policy HTML is the shared renderPolicyMarkdown output passed in as data —
// never a copied text — so hostile Markdown stays escaped paragraph text.
let { data }: PageProps = $props();
const { html, version, appUrl, leafCss } = $derived(data);
const canonical = $derived(canonicalUrl(appUrl, "/privacy"));
</script>

<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href="/privacy.md" />
</svelte:head>

{#snippet joinChrome()}
  <div>
    <span class="account-caption">Welcome, guest</span>
    <a class="btn" href="/join">Join with Discord</a>
  </div>
{/snippet}

<Shell
  title="Privacy policy"
  {canonical}
  theme="content"
  {leafCss}
  accountChrome={joinChrome}
  restoredWrite={data.restoredWrite}
>
  <div class="content-layout">
    <nav class="content-nav" aria-label="Community information">
      <a href="/about">About</a>
      <a href="/faq">FAQ</a>
      <a href="/rules">House rules</a>
      <a href="/privacy" aria-current="page">Privacy</a>
    </nav>
    <section class="content-page" aria-labelledby="privacy-heading">
      <h1 id="privacy-heading">Privacy policy</h1>
      <p class="strap" data-testid="privacy-version">Version {version}</p>
      <div data-testid="privacy-policy">{@html html}</div>
      <p>
        <a class="btn" href="/join" data-testid="privacy-join">Join with Discord</a>
        {" "}<a href="/">Back to the homepage</a>
      </p>
    </section>
  </div>
</Shell>
