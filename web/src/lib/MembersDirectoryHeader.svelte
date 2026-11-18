<script lang="ts">
import Button from "./Button.svelte";
import type { MembersDirectoryView } from "./members-directory";

let {
  counts,
  guest,
}: { counts: MembersDirectoryView["counts"]; guest: boolean } = $props();
const number = new Intl.NumberFormat("en");
</script>

<div class="members-heading">
  <p class="members-counts">
    {number.format(counts.members)} members · {number.format(counts.attendedThisMonth)} came to something this month
  </p>
  <h1>Who's here.{#if !guest} <span>Say hi to the new ones.</span>{/if}</h1>
  {#if guest}
    <p class="members-rule">Only signed-in members see names. Visitors see the counts.</p>
    <Button variant="primary" href="/auth/discord">Sign in with Discord to see who's here</Button>
  {/if}
</div>

<style>
  .members-heading { padding-block: 64px var(--space-8); }
  .members-counts {
    margin: 0 0 var(--space-3);
    color: var(--t3);
    font-family: var(--font-data);
    font-size: var(--text-label);
    letter-spacing: var(--tracking-label);
    text-transform: uppercase;
  }
  .members-heading h1 {
    margin: 0;
    color: var(--t1);
    font-family: var(--font-display);
    font-size: var(--text-h1);
    text-wrap: balance;
  }
  .members-heading h1 span { color: var(--t3); }
  .members-rule {
    margin: var(--space-4) 0 var(--space-5);
    color: var(--t2);
    font-size: var(--text-lede);
  }
  @media (max-width: 820px) {
    .members-heading { padding-block: 36px var(--space-6); }
  }
</style>
