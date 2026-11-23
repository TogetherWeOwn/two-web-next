<script lang="ts">
import type { ComponentProps } from "svelte";
import type { HeaderSession } from "../../../src/env";
import CalendarScreen from "./CalendarScreen.svelte";
import EmberShell from "./EmberShell.svelte";
import SiteMetadata from "./SiteMetadata.svelte";

type Props = {
  canonical: string;
  robots?: string;
  session: HeaderSession | null;
  screen: ComponentProps<typeof CalendarScreen>;
};
let { canonical, robots, session, screen }: Props = $props();
const { member, loginReturnTo } = $derived(screen);
</script>

<SiteMetadata title="Events" theme="schedule" {canonical} {robots}
  description="Game nights, tournaments and whatever else the community puts on." />
<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href="/events.md" />
  <link rel="stylesheet" href="/kit-site-header.css" />
</svelte:head>
{#snippet account()}
  {#if member}
    <a class="btn" href="/discord">Open Discord</a>
  {:else if session}
    <form method="post" action="/logout">
      <span class="account-caption">Signed in</span>
      <span class="who">{session.username}</span>
      <button type="submit" class="link">Sign out</button>
    </form>
  {/if}
{/snippet}

<EmberShell activeNav="events" {member} {loginReturnTo} accountChrome={session || member ? account : undefined} menuFallbackOnly>
  <CalendarScreen {...screen} />
</EmberShell>
